export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  deletedAt: number | null;
  folderId: string | null;
  // Manual order key inside folderId; 0 means "not positioned yet".
  position: number;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export type NoteContentInput = Pick<Note, 'title' | 'content' | 'tags' | 'pinned' | 'archived' | 'deletedAt'>;
// folderId stays optional: requests that omit it (old clients, AI tools) must keep the note where it is.
export type NoteInput = NoteContentInput & { folderId?: string | null };
export type NoteSummary = Omit<Note, 'content'> & { excerpt: string };
export interface NoteSearchMatch {
  field: 'title' | 'content';
  line: number | null;
  heading: string | null;
  startOffset: number | null;
  endOffset: number | null;
  snippet: string;
}
export type IntegrationNoteSummary = NoteSummary & {
  matches: NoteSearchMatch[];
  uri: string;
};
export interface Version extends NoteContentInput {
  revision: number;
  savedAt: number;
  actorType: 'user' | 'ai';
  actorName: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

// Top-level folders count as depth 1.
export const MAX_FOLDER_DEPTH = 5;
// Clients cap ZIP entries at 1200, so the server keeps folders within the same budget
// and a full library always stays exportable.
export const MAX_FOLDERS = 1200;

export function folderDepth(folders: Pick<Folder, 'id' | 'parentId'>[], id: string): number | null {
  let depth = 0;
  let current: string | null = id;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current)) return null;
    visited.add(current);
    const folder = folders.find((item) => item.id === current);
    if (!folder) return null;
    depth++;
    current = folder.parentId;
  }
  return depth;
}

export interface IntegrationToken {
  id: string;
  name: string;
  access: 'read' | 'read-write';
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export interface NoteTask {
  noteId: string;
  noteTitle: string;
  text: string;
  line: number;
  offset: number;
  archived: boolean;
}

export interface UserAccount {
  id: string;
  username: string;
  role: 'admin' | 'user';
  enabled: boolean;
  pendingApproval: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NoteShare {
  createdAt: number;
  expiresAt: number | null;
}

export interface ManagedNoteShare extends NoteShare {
  noteId: string;
  title: string;
  noteUpdatedAt: number;
  archived: boolean;
}

export interface SharedNote {
  title: string;
  content: string;
  tags: string[];
  updatedAt: number;
  expiresAt: number | null;
}

export interface ClientConfig {
  maxNoteBytes: number;
  maxImageBytes: number;
  maxImagePixels: number;
  maxAttachmentBytes: number;
  autosaveMs: number;
  pollSeconds: number;
}

export interface Session {
  user: { id: string; username: string; role: 'admin' | 'user'; hasRecoveryCode: boolean } | null;
  csrf: string | null;
  configured: boolean;
  registrationEnabled: boolean;
  config: ClientConfig;
  expiresAt: number | null;
  offline?: boolean;
}

export interface StoredFile {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  sha256: string;
  url: string;
}

export type ImageRecord = StoredFile;

export interface SyncChange {
  sequence: number;
  noteId: string;
  note: Note | null;
}

export const noteInput = (note: Note): NoteInput => ({
  title: note.title, content: note.content, tags: note.tags,
  pinned: note.pinned, archived: note.archived, deletedAt: note.deletedAt,
  folderId: note.folderId ?? null,
});

// Content fields only: note_versions and history never store folder placement.
export function sameVersionedInput(left: NoteInput, right: NoteInput): boolean {
  return left.title === right.title &&
    left.content === right.content &&
    left.archived === right.archived &&
    left.deletedAt === right.deletedAt &&
    left.tags.length === right.tags.length &&
    left.tags.every((tag) => right.tags.includes(tag));
}

export function sameNoteInput(left: NoteInput, right: NoteInput): boolean {
  return left.pinned === right.pinned &&
    (left.folderId ?? null) === (right.folderId ?? null) &&
    sameVersionedInput(left, right);
}

export const imagePath = (id: string) => `/api/images/${id}`;
export const filePath = (id: string) => `/api/files/${id}`;
export const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const fingerprintPattern = /^[a-f0-9]{64}$/;

export async function noteFingerprint(title: string, content: string): Promise<string> {
  const source = content ? `content\u0000${content}` : `empty\u0000${title.trim()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function storedFileIds(content: string): string[] {
  return [...new Set([...content.matchAll(/\/api\/(?:images|files)\/([0-9a-f-]{36})(?![0-9a-f-])/gi)]
    .map((match) => match[1]).filter((id) => idPattern.test(id)))];
}

export const imageIds = storedFileIds;

export function noteLinkIds(content: string): string[] {
  return [...new Set([...content.matchAll(/\[\[([0-9a-f-]{36})\|[^\]\r\n]{1,256}\]\]/gi)]
    .map((match) => match[1]).filter((id) => idPattern.test(id)))];
}
