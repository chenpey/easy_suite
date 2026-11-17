import { openDB, type DBSchema } from 'idb';

// Rules for receiving Android system shares through the PWA share target. The service worker stages a
// share locally, the page turns it into a new note. Nothing is sent to the server before the user's own
// autosave, so a received share works offline and needs no session cookie.
export const SHARE_TARGET_PATH = '/share-target';
export const SHARE_TARGET_FALLBACK_PATH = '/share-target-fallback.html';
export const SHARE_TARGET_TTL_MS = 10 * 60 * 1000;
// The manifest narrows the system share sheet to these types; the same list decides what may enter a note.
export const SHARE_TARGET_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/markdown'];
const DATABASE_NAME = 'easynote-share-target';
const PENDING_KEY = 'pending';
const TEXT_FIELDS = ['title', 'text', 'url'] as const;
// The server rejects longer titles; a shared page title is cut here instead of failing the save.
const MAX_TITLE_LENGTH = 256;

export interface SharedFile {
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
}

export interface SharedContent {
  title: string;
  text: string;
  url: string;
  files: SharedFile[];
  // Files the sharing app sent with a type EasyNote cannot store; the page reports them once.
  skipped: number;
}

export interface StoredShare extends SharedContent {
  state: 'pending';
  expiresAt: number;
}

export type PendingShare =
  | { status: 'empty' | 'invalid' | 'expired' }
  | ({ status: 'ready'; expiresAt: number } & SharedContent);

// A share navigates into the installed app from the operating system, so only a same-origin POST
// navigation may be staged. The service worker cannot read Sec-Fetch-* headers and a page can suppress
// Referer, so any page can post here too; the staged content only ever becomes a draft note the user did
// not ask for, which is the cost of receiving system shares without a server round trip.
export function canReceiveShare({ method, sameOrigin, pathname, mode }: {
  method: string;
  sameOrigin: boolean;
  pathname: string;
  mode: string;
}) {
  return method === 'POST' && sameOrigin && pathname === SHARE_TARGET_PATH && mode === 'navigate';
}

// Title, text and URL are kept verbatim; trimming only decides whether a field counts as empty.
export function composeSharedText({ title = '', text = '', url = '' }: Partial<Record<typeof TEXT_FIELDS[number], string>>) {
  return [title, text, url].filter((value) => value.trim()).join('\n');
}

const linkLabel = (value: string) => value.replace(/[[\]\\\r\n]/g, '');

// Only a plain http(s) address becomes a link. Anything else, including a javascript: URL that a page
// managed to post, stays as text instead of a clickable target the renderer has to reject.
const linkTarget = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return (protocol === 'http:' || protocol === 'https:') && !/\s/.test(value) ? value : '';
  } catch {
    return '';
  }
};

// The server rejects longer titles; cutting a code unit must not leave half of a surrogate pair behind.
const truncateTitle = (value: string) => {
  if (value.length <= MAX_TITLE_LENGTH) return value;
  const cut = value.slice(0, MAX_TITLE_LENGTH);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

// Turns a received share into the new note: the shared title becomes the note title, and a shared URL
// becomes one markdown link so the source page stays one click away.
export function composeNote({ title, text, url }: Pick<SharedContent, 'title' | 'text' | 'url'>) {
  const heading = truncateTitle(title.trim());
  const body = text.trim();
  const shared = url.trim();
  const link = linkTarget(shared);
  // A destination holding parentheses needs the angle-bracket form to stay a single Markdown link.
  const destination = /[()\s]/.test(link) ? `<${link}>` : link;
  const line = !shared || body.includes(shared)
    ? ''
    : link ? (heading ? `[${linkLabel(heading)}](${destination})` : `<${link}>`) : shared;
  return { title: heading, content: [body, line].filter(Boolean).join('\n\n') };
}

// Returns null for payloads that must not be staged: no text, no URL and no file EasyNote can store.
export function parseShareFormData(form: FormData): SharedContent | null {
  const fields: Record<typeof TEXT_FIELDS[number], string> = { title: '', text: '', url: '' };
  for (const name of TEXT_FIELDS) {
    const value = form.get(name);
    if (value === null) continue;
    if (typeof value !== 'string') return null;
    fields[name] = value;
  }
  const files: SharedFile[] = [];
  let skipped = 0;
  for (const value of form.getAll('files')) {
    if (typeof value === 'string') { skipped++; continue; }
    // An unselected file input arrives as an empty, nameless zero-byte entry.
    if (!value.name && value.size === 0) continue;
    // Sharing apps send MIME types with parameters or mixed case; the note stores the bare type.
    const type = value.type.split(';')[0].trim().toLowerCase();
    if (!SHARE_TARGET_MIMES.includes(type)) { skipped++; continue; }
    files.push({ blob: value, name: value.name, type, lastModified: value.lastModified });
  }
  if (!composeSharedText(fields) && !files.length) return null;
  return { ...fields, files, skipped };
}

// The record shape is shared by the worker that stages a share and the page that hands one back
// unchanged when it could not be imported yet.
export const pendingRecord = (content: SharedContent, expiresAt: number): StoredShare =>
  ({ state: 'pending', expiresAt, ...content });
export const createPendingShare = (content: SharedContent, now: number): StoredShare =>
  pendingRecord(content, now + SHARE_TARGET_TTL_MS);

const isStoredFile = (file: unknown): file is SharedFile => {
  if (!file || typeof file !== 'object') return false;
  const stored = file as SharedFile;
  return typeof stored.name === 'string' && typeof stored.type === 'string' &&
    typeof stored.lastModified === 'number' && stored.blob instanceof Blob;
};

// Validated at the moment the slot is read, so an expired record never returns its content.
function inspectPendingShare(record: unknown, now: number): PendingShare {
  if (record === undefined || record === null) return { status: 'empty' };
  const stored = record as StoredShare;
  const valid = stored.state === 'pending' &&
    typeof stored.expiresAt === 'number' && Number.isFinite(stored.expiresAt) &&
    TEXT_FIELDS.every((name) => typeof stored[name] === 'string') &&
    typeof stored.skipped === 'number' &&
    Array.isArray(stored.files) && stored.files.every(isStoredFile);
  if (!valid) return { status: 'invalid' };
  if (now >= stored.expiresAt) return { status: 'expired' };
  return {
    status: 'ready',
    expiresAt: stored.expiresAt,
    title: stored.title,
    text: stored.text,
    url: stored.url,
    files: stored.files,
    skipped: stored.skipped,
  };
}

interface ShareTargetSchema extends DBSchema {
  pending: { key: string; value: StoredShare };
}

const database = () => openDB<ShareTargetSchema>(DATABASE_NAME, 1, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending');
  },
});

// Peeking keeps a share that waits for a connection; claiming hands it to the page exactly once.
export async function readPendingShare(): Promise<PendingShare> {
  const db = await database();
  try {
    const record = await db.transaction('pending', 'readonly').objectStore('pending').get(PENDING_KEY);
    return inspectPendingShare(record, Date.now());
  } finally {
    db.close();
  }
}

export async function claimPendingShare(): Promise<PendingShare> {
  const db = await database();
  try {
    const transaction = db.transaction('pending', 'readwrite');
    const store = transaction.objectStore('pending');
    const record = await store.get(PENDING_KEY);
    // The clock is read after the read finishes, so a record that expired while the transaction waited
    // is never handed to the page.
    const pending = inspectPendingShare(record, Date.now());
    if (pending.status !== 'empty') await store.delete(PENDING_KEY);
    await transaction.done;
    return pending;
  } finally {
    db.close();
  }
}

// Replaces the whole slot; a failed write keeps the previous share.
export async function savePendingShare(share: StoredShare): Promise<void> {
  const db = await database();
  try {
    await db.put('pending', share, PENDING_KEY);
  } finally {
    db.close();
  }
}
