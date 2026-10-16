import {
  fingerprintPattern,
  idPattern,
  noteFingerprint,
  noteInput,
  sameNoteInput,
  sameVersionedInput,
  storedFileIds,
  type Note,
  type NoteInput,
  type SyncChange,
  type Version,
} from '../shared/types';
import { ApiError, clientConfig, digest, json, numberSetting, readJson, type Env } from './core';
import type { Identity } from './auth';
import { placePositions } from '../shared/order';
import { publishNoteChanges } from './events';

export interface NoteRow {
  id: string; user_id: string; title: string; content: string; tags: string; pinned: number; archived: number;
  deleted_at: number | null; folder_id: string | null; created_at: number; updated_at: number; revision: number;
  position: number; dedup_hash: string; mutation_id: string; mutation_hash: string;
}
interface VersionInputRow {
  title: string; content: string; tags: string; pinned: number; archived: number; deleted_at: number | null;
}
// folderId stays optional: old clients and AI requests omit it and must keep the stored placement.
type NoteSaveInput = Omit<NoteInput, 'folderId'> & { folderId: string | null | undefined };
export const toNote = (row: NoteRow): Note => ({
  id: row.id, title: row.title, content: row.content, tags: JSON.parse(row.tags),
  pinned: !!row.pinned, archived: !!row.archived, deletedAt: row.deleted_at,
  folderId: row.folder_id ?? null, position: row.position,
  createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
});
const versionInput = (row: VersionInputRow): NoteInput => ({
  title: row.title, content: row.content, tags: JSON.parse(row.tags),
  pinned: !!row.pinned, archived: !!row.archived, deletedAt: row.deleted_at, folderId: null,
});

export async function loadNote(env: Env, userId: string, id: string): Promise<NoteRow | null> {
  return env.DB.prepare('SELECT * FROM notes WHERE id=? AND user_id=?').bind(id, userId).first<NoteRow>();
}

const blankCondition = "title='' AND content='' AND tags='[]' AND archived=0 AND deleted_at IS NULL";
// Blank notes are unique per folder, so create never reuses a blank note from another folder.
const blankFolderCondition = "COALESCE(folder_id,'')=?";

async function loadBlank(env: Env, userId: string, folderId: string | null): Promise<NoteRow | null> {
  return env.DB.prepare(`SELECT * FROM notes WHERE user_id=? AND ${blankCondition} AND ${blankFolderCondition} LIMIT 1`)
    .bind(userId, folderId ?? '').first<NoteRow>();
}

const folderExists = (env: Env, userId: string, folderId: string) =>
  env.DB.prepare('SELECT id FROM folders WHERE id=? AND user_id=?').bind(folderId, userId).first();

function isBlank(input: NoteInput): boolean {
  return !input.title && !input.content && !input.tags.length && !input.archived && input.deletedAt === null;
}

function validate(data: Record<string, unknown>, env: Env): NoteSaveInput {
  if (typeof data.title !== 'string' || data.title.length > 256 ||
      typeof data.content !== 'string' ||
      new TextEncoder().encode(data.content).length > clientConfig(env).maxNoteBytes ||
      !Array.isArray(data.tags) || data.tags.length > 20 ||
      data.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 40) ||
      typeof data.pinned !== 'boolean' ||
      typeof data.archived !== 'boolean' ||
      !(data.folderId === undefined || data.folderId === null ||
        typeof data.folderId === 'string' && idPattern.test(data.folderId)) ||
      !(data.deletedAt === null || typeof data.deletedAt === 'number' && Number.isSafeInteger(data.deletedAt) && data.deletedAt > 0)) {
    throw new ApiError(400, 'Invalid note fields or note size limit exceeded.');
  }
  return {
    title: data.title.trim(), content: data.content,
    tags: [...new Set((data.tags as string[]).map((tag) => tag.trim()))],
    pinned: data.pinned, archived: data.archived, deletedAt: data.deletedAt as number | null,
    folderId: data.folderId as string | null | undefined,
  };
}

export async function saveNote(request: Request, env: Env, user: Identity, id: string, create: boolean): Promise<Response> {
  const data = await readJson(request, clientConfig(env).maxNoteBytes * 6 + 8192);
  const input = validate(data, env);
  if (!idPattern.test(id) || typeof data.operationId !== 'string' || !idPattern.test(data.operationId) ||
      !Number.isSafeInteger(data.revision) || Number(data.revision) < 0 ||
      data.createVersion !== undefined && typeof data.createVersion !== 'boolean' ||
      (create && data.revision !== 0) || (!create && data.revision === 0)) {
    throw new ApiError(400, 'Invalid revision or operation ID.');
  }
  const createVersion = user.actorType === 'ai' || data.createVersion === true;
  const dedupHash = await noteFingerprint(input.title, input.content);
  // One D1 round trip for the current row and the purge tombstone.
  const [currentResult, purgedResult] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM notes WHERE id=? AND user_id=?').bind(id, user.id),
    env.DB.prepare('SELECT id FROM purged_notes WHERE id=?').bind(id),
  ]);
  const current = (currentResult.results as NoteRow[])[0] ?? null;
  if ((!create && !current) || purgedResult.results.length) {
    throw new ApiError(410, 'This note no longer exists. Keep a new copy of your draft.');
  }
  const folderId = create
    ? input.folderId ?? null
    : input.folderId === undefined ? current!.folder_id : input.folderId;
  if (folderId !== null && folderId !== current?.folder_id && !await folderExists(env, user.id, folderId)) {
    throw new ApiError(400, 'Folder not found.');
  }
  const normalized: NoteInput = { ...input, folderId };
  const hash = await digest(JSON.stringify({ ...normalized, revision: data.revision, createVersion }));
  if (current?.mutation_id === data.operationId) {
    if (current.mutation_hash !== hash) {
      const { folderId: _folderId, ...legacyInput } = normalized;
      const legacyHash = folderId === null
        ? await digest(JSON.stringify({ ...legacyInput, revision: data.revision, createVersion })) : null;
      if (current.mutation_hash !== legacyHash) throw new ApiError(409, 'Operation ID reused with different content.');
    }
    return json({ note: toNote(current) });
  }
  if (current && (create || current.revision !== data.revision)) {
    throw new ApiError(409, 'The note changed on another device.', { current: toNote(current) });
  }
  const currentInput = current ? noteInput(toNote(current)) : null;
  const latestVersion = createVersion && current
    ? await env.DB.prepare(`SELECT title,content,tags,pinned,archived,deleted_at
      FROM note_versions WHERE note_id=? ORDER BY revision DESC LIMIT 1`)
      .bind(id).first<VersionInputRow>()
    : null;
  const shouldCreateVersion = createVersion &&
    (!latestVersion || !sameVersionedInput(versionInput(latestVersion), normalized));
  if (current && currentInput && sameNoteInput(currentInput, normalized)) {
    if (!shouldCreateVersion) return json({ note: toNote(current), unchanged: true });
    const time = Date.now();
    const revision = current.revision;
    const mutation = data.operationId as string;
    const guard = 'EXISTS(SELECT 1 FROM notes WHERE id=? AND user_id=? AND revision=? AND mutation_id=?)';
    const guardBinds = [id, user.id, revision, mutation];
    const keep = numberSetting(env, 'VERSIONS_KEPT', 1, 100);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE notes SET mutation_id=?,mutation_hash=?
        WHERE id=? AND user_id=? AND revision=?`)
        .bind(mutation, hash, id, user.id, revision),
      env.DB.prepare(`INSERT OR IGNORE INTO note_versions
        (note_id,revision,title,content,tags,pinned,deleted_at,saved_at,archived,actor_type,actor_name)
        SELECT id,revision,title,content,tags,pinned,deleted_at,?,archived,?,? FROM notes
        WHERE id=? AND user_id=? AND revision=? AND mutation_id=?`)
        .bind(time, user.actorType, user.actorName, ...guardBinds),
      env.DB.prepare(`DELETE FROM note_versions WHERE note_id=? AND revision NOT IN
        (SELECT revision FROM note_versions WHERE note_id=? ORDER BY revision DESC LIMIT ?) AND ${guard}`)
        .bind(id, id, keep, ...guardBinds),
      env.DB.prepare(`DELETE FROM image_refs WHERE note_id=? AND revision<>? AND revision NOT IN
        (SELECT revision FROM note_versions WHERE note_id=?) AND ${guard}`)
        .bind(id, revision, id, ...guardBinds),
    ]);
    const saved = await loadNote(env, user.id, id);
    if (!results[0].meta.changes || !saved) {
      throw new ApiError(409, 'The note changed on another device.', { current: saved ? toNote(saved) : undefined });
    }
    return json({ note: toNote(saved), unchanged: true });
  }
  const ids = storedFileIds(normalized.content);
  if (ids.length > 80) throw new ApiError(400, 'A note can reference at most 80 stored files.');
  const idsJson = JSON.stringify(ids);
  const readyCondition = ids.length
    ? `(SELECT COUNT(*) FROM images WHERE user_id=? AND status='ready'
        AND id IN (SELECT value FROM json_each(?)))=?`
    : '1=1';
  const readyBinds = ids.length ? [user.id, idsJson, ids.length] : [];
  // Re-checked inside the write, so a folder deleted after the pre-check cannot leave
  // an orphaned note or fail the batch with a foreign-key error.
  const folderCondition = '(? IS NULL OR EXISTS(SELECT 1 FROM folders WHERE id=? AND user_id=?))';
  const folderBinds: unknown[] = [folderId, folderId, user.id];
  const time = Date.now();
  const revision = Number(data.revision) + 1;
  const mutation = data.operationId;
  const fields = [
    normalized.title, normalized.content, dedupHash, JSON.stringify(normalized.tags),
    normalized.pinned ? 1 : 0, normalized.archived ? 1 : 0, normalized.deletedAt, folderId,
  ];
  const statements: D1PreparedStatement[] = [];
  if (create) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO notes
      (id,user_id,title,content,dedup_hash,tags,pinned,archived,deleted_at,folder_id,created_at,updated_at,revision,mutation_id,mutation_hash)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE ${readyCondition}
        AND ${folderCondition}
        AND NOT EXISTS(SELECT 1 FROM purged_notes WHERE id=?)
        AND (SELECT COUNT(*) FROM notes WHERE user_id=?)<? RETURNING *`)
      .bind(id, user.id, ...fields, time, time, revision, mutation, hash, ...readyBinds, ...folderBinds, id, user.id, numberSetting(env, 'MAX_NOTES', 1, 10000)));
  } else {
    // A note that changes folder is appended to the target, so it never carries a key that
    // belonged to the old folder's ordering.
    statements.push(env.DB.prepare(`UPDATE OR IGNORE notes SET title=?,content=?,dedup_hash=?,tags=?,pinned=?,archived=?,deleted_at=?,
      folder_id=?,position=CASE WHEN COALESCE(folder_id,'')=COALESCE(?,'') THEN position
        ELSE (SELECT COALESCE(MAX(position),0)+1 FROM notes WHERE user_id=? AND deleted_at IS NULL
          AND COALESCE(folder_id,'')=COALESCE(?,'')) END,
      updated_at=?,revision=?,mutation_id=?,mutation_hash=?
      WHERE id=? AND user_id=? AND revision=? AND ${readyCondition} AND ${folderCondition} RETURNING *`)
      .bind(...fields, folderId, user.id, folderId, time, revision, mutation, hash, id, user.id, data.revision, ...readyBinds, ...folderBinds));
  }
  const guard = 'EXISTS(SELECT 1 FROM notes WHERE id=? AND user_id=? AND revision=? AND mutation_id=?)';
  const guardBinds = [id, user.id, revision, mutation];
  if (shouldCreateVersion) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO note_versions
      (note_id,revision,title,content,tags,pinned,deleted_at,saved_at,archived,actor_type,actor_name)
      SELECT id,revision,title,content,tags,pinned,deleted_at,updated_at,archived,?,? FROM notes
      WHERE id=? AND user_id=? AND revision=? AND mutation_id=?`)
      .bind(user.actorType, user.actorName, ...guardBinds));
  }
  statements.push(env.DB.prepare(`INSERT INTO note_changes(user_id,note_id,changed_at)
    SELECT ?,?,? WHERE ${guard}`).bind(user.id, id, time, ...guardBinds));
  if (normalized.deletedAt !== null) {
    statements.push(env.DB.prepare(`DELETE FROM note_shares WHERE note_id=? AND ${guard}`)
      .bind(id, ...guardBinds));
  }
  if (ids.length) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO image_refs(note_id,image_id,revision)
      SELECT ?,value,? FROM json_each(?) WHERE ${guard}`)
      .bind(id, revision, idsJson, ...guardBinds));
    statements.push(env.DB.prepare(`UPDATE images SET last_used_at=? WHERE user_id=?
      AND id IN (SELECT value FROM json_each(?)) AND ${guard}`)
      .bind(time, user.id, idsJson, ...guardBinds));
  }
  const keep = numberSetting(env, 'VERSIONS_KEPT', 1, 100);
  statements.push(env.DB.prepare(`DELETE FROM note_versions WHERE note_id=? AND revision NOT IN
    (SELECT revision FROM note_versions WHERE note_id=? ORDER BY revision DESC LIMIT ?) AND ${guard}`)
    .bind(id, id, keep, ...guardBinds));
  statements.push(env.DB.prepare(`DELETE FROM image_refs WHERE note_id=? AND revision<>? AND revision NOT IN
    (SELECT revision FROM note_versions WHERE note_id=?) AND ${guard}`)
    .bind(id, revision, id, ...guardBinds));
  statements.push(env.DB.prepare(`DELETE FROM note_changes WHERE user_id=? AND note_id=? AND sequence<
    (SELECT MAX(sequence) FROM note_changes WHERE user_id=? AND note_id=?) AND ${guard}`)
    .bind(user.id, id, user.id, id, ...guardBinds));
  const result = await env.DB.batch(statements);
  // The first statement's RETURNING row is the saved note; nothing later in the batch writes notes.
  const written = (result[0].results as NoteRow[])[0];
  if (!written) {
    if (!create && isBlank(normalized)) {
      const blank = await loadBlank(env, user.id, folderId);
      if (blank && blank.id !== id) throw new ApiError(409, 'The target folder already contains a blank note.');
    }
    if (create && isBlank(normalized)) {
      const blank = await loadBlank(env, user.id, folderId);
      if (blank) return json({ note: toNote(blank), reused: true });
    }
    if (folderId !== null && !await folderExists(env, user.id, folderId)) {
      throw new ApiError(409, 'The target folder no longer exists.', { folderMissing: true });
    }
    const latest = await loadNote(env, user.id, id);
    if (latest) throw new ApiError(409, 'The note changed on another device.', { current: toNote(latest) });
    throw new ApiError(409, 'An image is unavailable, the note was purged, or the note limit was reached.');
  }
  publishNoteChanges(env, user.id, request);
  return json({ note: toNote(written) }, create ? 201 : 200);
}

// Display order of one folder's notes; the key the manual list order sorts by.
async function orderedNotes(env: Env, userId: string, folderId: string | null): Promise<Array<{ id: string; position: number }>> {
  const rows = await env.DB.prepare(`SELECT id,position FROM notes
    WHERE user_id=? AND deleted_at IS NULL AND folder_id IS ?
    ORDER BY pinned DESC,position ASC,updated_at DESC,id ASC`)
    .bind(userId, folderId).all<{ id: string; position: number }>();
  return rows.results;
}

// Reordering is metadata only: content, revision and updated_at stay untouched, so drafts and
// optimistic concurrency keep working while other devices pick the order up through sync.
async function orderNotes(request: Request, env: Env, user: Identity): Promise<Response> {
  // A multi-selection can cover an entire library, so size the body for MAX_NOTES IDs.
  const data = await readJson(request, 1024 * 1024);
  if (Object.keys(data).some((key) => !['ids', 'afterId', 'beforeId'].includes(key))) throw new ApiError(400, 'Invalid order fields.');
  const ids = data.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > numberSetting(env, 'MAX_NOTES', 1, 10000) ||
      ids.some((id) => typeof id !== 'string' || !idPattern.test(id)) || new Set(ids).size !== ids.length) {
    throw new ApiError(400, 'Invalid note IDs.');
  }
  const anchor = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !idPattern.test(value)) throw new ApiError(400, 'Invalid anchor note ID.');
    return value;
  };
  const afterId = anchor(data.afterId);
  const beforeId = anchor(data.beforeId);
  if (afterId && beforeId) throw new ApiError(400, 'Provide at most one anchor note.');
  const moving = ids as string[];
  if (moving.includes(afterId ?? '') || moving.includes(beforeId ?? '')) throw new ApiError(400, 'An anchor note cannot be moved.');
  // One JSON argument keeps the ID list within D1's per-query parameter limit.
  const idsJson = JSON.stringify(moving);
  const rows = await env.DB.prepare(`SELECT id,folder_id FROM notes
    WHERE user_id=? AND id IN (SELECT value FROM json_each(?))`)
    .bind(user.id, idsJson).all<{ id: string; folder_id: string | null }>();
  if (rows.results.length !== moving.length) throw new ApiError(404, 'Note not found.');
  const folderId = rows.results[0].folder_id;
  if (rows.results.some((row) => (row.folder_id ?? null) !== (folderId ?? null))) {
    throw new ApiError(400, 'Notes can only be reordered inside their own folder.');
  }
  const ordered = await orderedNotes(env, user.id, folderId);
  const rest = ordered.filter((row) => !moving.includes(row.id));
  let index = rest.length;
  if (afterId || beforeId) {
    const at = rest.findIndex((row) => row.id === (afterId ?? beforeId));
    if (at < 0) throw new ApiError(400, 'Anchor note not found in this folder.');
    index = afterId ? at + 1 : at;
  }
  const positions = placePositions(ordered, moving, index);
  // A gap too small renumbers the neighbours as well, so every rewritten key is written,
  // published and returned; otherwise the client keeps sorting with stale keys.
  const changed = [...positions.keys()];
  // Metadata only: the client already holds each note and only needs the new keys.
  const updatesJson = JSON.stringify(changed.map((id) => ({ id, position: positions.get(id)! })));
  const time = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE notes SET position=(SELECT json_extract(value,'$.position') FROM json_each(?)
        WHERE json_extract(value,'$.id')=notes.id)
      WHERE user_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`)
      .bind(updatesJson, user.id, updatesJson),
    env.DB.prepare(`INSERT INTO note_changes(user_id,note_id,changed_at)
      SELECT ?,id,? FROM notes WHERE user_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`)
      .bind(user.id, time, user.id, updatesJson),
  ]);
  publishNoteChanges(env, user.id, request);
  return json({ notes: changed.map((id) => ({ id, position: positions.get(id)! })) });
}

export async function noteRoutes(request: Request, env: Env, user: Identity, path: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (path === '/api/sync/cursor' && request.method === 'GET') {
    const head = await env.DB.prepare('SELECT COALESCE(MAX(sequence),0) AS cursor FROM note_changes WHERE user_id=?')
      .bind(user.id).first<{ cursor: number }>();
    return json({ cursor: head?.cursor ?? 0 });
  }
  if (path === '/api/sync' && request.method === 'GET') {
    const after = Number(url.searchParams.get('after') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new ApiError(400, 'Invalid sync cursor or limit.');
    }
    const result = await env.DB.prepare(`SELECT c.sequence,c.note_id AS change_note_id,n.*
      FROM note_changes c LEFT JOIN notes n ON n.id=c.note_id AND n.user_id=c.user_id
      WHERE c.user_id=? AND c.sequence>? ORDER BY c.sequence ASC LIMIT ?`)
      .bind(user.id, after, limit + 1).all<NoteRow & { sequence: number; change_note_id: string }>();
    const rows = result.results.slice(0, limit);
    const changes: SyncChange[] = rows.map((row) => ({
      sequence: row.sequence,
      noteId: row.change_note_id,
      note: row.id ? toNote(row) : null,
    }));
    return json({
      changes,
      cursor: changes.at(-1)?.sequence ?? after,
      hasMore: result.results.length > limit,
    });
  }
  if (path === '/api/notes' && request.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    const ftsQuery = Array.from(q).length >= 3 && /\S/.test(q)
      ? `"${q.replaceAll('"', '""')}"`
      : null;
    const view = url.searchParams.get('view') ?? 'all';
    if (!['all', 'archive', 'trash', 'export'].includes(view)) throw new ApiError(400, 'Invalid note view.');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError(400, 'Invalid offset.');
    const limit = Number(url.searchParams.get('limit') ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, 'Invalid limit.');
    const tag = (url.searchParams.get('tag') ?? '').slice(0, 40);
    const escape = (value: string) => value.replace(/[\\%_]/g, '\\$&');
    const filters = ['user_id=?'];
    const binds: unknown[] = [user.id];
    if (view === 'trash') filters.push('deleted_at IS NOT NULL');
    else if (view === 'archive') filters.push('deleted_at IS NULL', 'archived=1');
    else if (view === 'all') filters.push('deleted_at IS NULL', 'archived=0');
    const folder = url.searchParams.get('folder') ?? '';
    if (folder === 'root') filters.push('folder_id IS NULL');
    else if (folder) {
      if (!idPattern.test(folder)) throw new ApiError(400, 'Invalid folder filter.');
      filters.push('folder_id=?');
      binds.push(folder);
    }
    // Manual order only exists inside one folder view; every other list stays last-modified.
    const manualOrder = url.searchParams.get('sort') === 'manual' && !!folder && view === 'all' && !q && !tag;
    if (ftsQuery) {
      filters.push('notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)');
      binds.push(ftsQuery);
    } else if (q) {
      filters.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
      binds.push(`%${escape(q)}%`, `%${escape(q)}%`);
    }
    if (tag) { filters.push('EXISTS(SELECT 1 FROM json_each(notes.tags) WHERE value=?)'); binds.push(tag); }
    const excerpt = q
      ? `(CASE WHEN instr(lower(content),lower(?))>61 THEN '…' ELSE '' END) ||
        substr(content,max(1,instr(lower(content),lower(?))-60),max(180,length(?)+60))`
      : 'substr(content,1,180)';
    const result = await env.DB.prepare(`SELECT id,title,${excerpt} AS content,tags,pinned,archived,deleted_at,folder_id,position,created_at,updated_at,revision
      FROM notes WHERE ${filters.join(' AND ')}
      ORDER BY pinned DESC,${manualOrder ? 'position ASC,' : ''}updated_at DESC,id ASC LIMIT ? OFFSET ?`)
      .bind(...(q ? [q, q, q] : []), ...binds, limit + 1, offset).all<NoteRow>();
    const notes = result.results.slice(0, limit).map((row) => {
      const { content, ...note } = toNote(row);
      return { ...note, excerpt: content };
    });
    return json({ notes, nextOffset: result.results.length > limit ? offset + limit : null });
  }
  if (path === '/api/tags' && request.method === 'GET') {
    const view = url.searchParams.get('view') ?? 'all';
    if (!['all', 'archive', 'trash'].includes(view)) throw new ApiError(400, 'Invalid note view.');
    const scope = view === 'trash'
      ? 'deleted_at IS NOT NULL'
      : `deleted_at IS NULL AND archived=${view === 'archive' ? 1 : 0}`;
    const result = await env.DB.prepare(`SELECT DISTINCT value AS name FROM notes,json_each(notes.tags)
      WHERE user_id=? AND ${scope} ORDER BY value LIMIT 200`).bind(user.id).all<{ name: string }>();
    return json({ tags: result.results.map((row) => row.name) });
  }
  if (path === '/api/notes/existing' && request.method === 'POST') {
    const data = await readJson(request, 48 * 1024);
    if (Object.keys(data).some((key) => key !== 'ids') || !Array.isArray(data.ids) ||
        data.ids.length > 1200 || data.ids.some((id) => typeof id !== 'string' || !idPattern.test(id))) {
      throw new ApiError(400, 'Invalid note IDs.');
    }
    const ids = [...new Set(data.ids as string[])];
    const statements: D1PreparedStatement[] = [];
    for (let offset = 0; offset < ids.length; offset += 80) {
      const chunk = ids.slice(offset, offset + 80);
      statements.push(env.DB.prepare(`SELECT id FROM notes WHERE user_id=? AND id IN (${chunk.map(() => '?').join(',')})`)
        .bind(user.id, ...chunk));
    }
    const results = statements.length ? await env.DB.batch<{ id: string }>(statements) : [];
    return json({ ids: results.flatMap((result) => result.results.map((row) => row.id)) });
  }
  if (path === '/api/notes/duplicates' && request.method === 'POST') {
    const data = await readJson(request, 96 * 1024);
    if (Object.keys(data).some((key) => key !== 'fingerprints') || !Array.isArray(data.fingerprints) ||
        data.fingerprints.length > 1200 ||
        data.fingerprints.some((fingerprint) => typeof fingerprint !== 'string' || !fingerprintPattern.test(fingerprint))) {
      throw new ApiError(400, 'Invalid note fingerprints.');
    }
    const fingerprints = [...new Set(data.fingerprints as string[])];
    const statements: D1PreparedStatement[] = [];
    for (let offset = 0; offset < fingerprints.length; offset += 80) {
      const chunk = fingerprints.slice(offset, offset + 80);
      statements.push(env.DB.prepare(`SELECT dedup_hash AS fingerprint,MIN(id) AS note_id FROM notes
        WHERE user_id=? AND dedup_hash IN (${chunk.map(() => '?').join(',')}) GROUP BY dedup_hash`)
        .bind(user.id, ...chunk));
    }
    const results = statements.length
      ? await env.DB.batch<{ fingerprint: string; note_id: string }>(statements)
      : [];
    return json({
      matches: results.flatMap((result) =>
        result.results.map((row) => ({ fingerprint: row.fingerprint, noteId: row.note_id }))),
    });
  }
  if (path === '/api/notes/trash' && request.method === 'DELETE') {
    const time = Date.now();
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM notes WHERE user_id=? AND deleted_at IS NOT NULL')
      .bind(user.id).first<{ count: number }>();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO note_changes(user_id,note_id,changed_at)
        SELECT user_id,id,? FROM notes WHERE user_id=? AND deleted_at IS NOT NULL`).bind(time, user.id),
      env.DB.prepare(`INSERT OR IGNORE INTO purged_notes
        SELECT id,user_id,? FROM notes WHERE user_id=? AND deleted_at IS NOT NULL`).bind(time, user.id),
      env.DB.prepare('DELETE FROM notes WHERE user_id=? AND deleted_at IS NOT NULL').bind(user.id),
      env.DB.prepare(`DELETE FROM note_changes WHERE user_id=? AND sequence NOT IN
        (SELECT MAX(sequence) FROM note_changes WHERE user_id=? GROUP BY note_id)`).bind(user.id, user.id),
    ]);
    if (count?.count) publishNoteChanges(env, user.id, request);
    return json({ deleted: count?.count ?? 0 });
  }
  if (path === '/api/notes/blank' && request.method === 'GET') {
    const folder = url.searchParams.get('folder');
    if (folder !== null && folder !== 'root' && !idPattern.test(folder)) throw new ApiError(400, 'Invalid folder filter.');
    const row = await loadBlank(env, user.id, folder === null || folder === 'root' ? null : folder);
    return json({ note: row ? toNote(row) : null });
  }
  if (path === '/api/notes/order' && request.method === 'PATCH') return orderNotes(request, env, user);
  const match = /^\/api\/notes\/([^/]+)(?:\/(versions|backlinks))?$/.exec(path);
  if (!match) return null;
  const id = match[1];
  if (!idPattern.test(id)) throw new ApiError(404, 'Note not found.');
  if (match[2] && request.method === 'GET') {
    if (!await loadNote(env, user.id, id)) throw new ApiError(404, 'Note not found.');
    if (match[2] === 'backlinks') {
      const escaped = id.replace(/[\\%_]/g, '\\$&');
      const rows = await env.DB.prepare(`SELECT id,title,substr(content,1,180) AS content,tags,pinned,archived,
        deleted_at,folder_id,position,created_at,updated_at,revision FROM notes
        WHERE user_id=? AND deleted_at IS NULL AND content LIKE ? ESCAPE '\\'
        ORDER BY updated_at DESC,id ASC LIMIT 200`).bind(user.id, `%[[${escaped}|%`).all<NoteRow>();
      return json({
        notes: rows.results.map((row) => {
          const { content, ...note } = toNote(row);
          return { ...note, excerpt: content };
        }),
      });
    }
    const rows = await env.DB.prepare('SELECT * FROM note_versions WHERE note_id=? ORDER BY revision DESC')
      .bind(id).all<NoteRow & { saved_at: number; actor_type: 'user' | 'ai'; actor_name: string }>();
    const versions: Version[] = rows.results.map((row) => ({
      title: row.title, content: row.content, tags: JSON.parse(row.tags), pinned: !!row.pinned,
      archived: !!row.archived, deletedAt: row.deleted_at, revision: row.revision, savedAt: row.saved_at,
      actorType: row.actor_type, actorName: row.actor_name,
    }));
    return json({ versions });
  }
  if (match[2]) return null;
  if (request.method === 'GET') {
    const row = await loadNote(env, user.id, id);
    if (!row) throw new ApiError(404, 'Note not found.');
    return json({ note: toNote(row) });
  }
  if (request.method === 'POST' || request.method === 'PUT') return saveNote(request, env, user, id, request.method === 'POST');
  if (request.method === 'DELETE') {
    const data = await readJson(request);
    if (!Number.isSafeInteger(data.revision)) throw new ApiError(400, 'Revision required.');
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO note_changes(user_id,note_id,changed_at)
        SELECT user_id,id,? FROM notes WHERE id=? AND user_id=? AND deleted_at IS NOT NULL AND revision=?`)
        .bind(Date.now(), id, user.id, data.revision),
      env.DB.prepare(`INSERT OR IGNORE INTO purged_notes SELECT id,user_id,? FROM notes
        WHERE id=? AND user_id=? AND deleted_at IS NOT NULL AND revision=?`)
        .bind(Date.now(), id, user.id, data.revision),
      env.DB.prepare(`DELETE FROM notes WHERE id=? AND user_id=? AND deleted_at IS NOT NULL AND revision=?
        AND EXISTS(SELECT 1 FROM purged_notes WHERE id=?)`).bind(id, user.id, data.revision, id),
      env.DB.prepare(`DELETE FROM note_changes WHERE user_id=? AND note_id=? AND sequence<
        (SELECT MAX(sequence) FROM note_changes WHERE user_id=? AND note_id=?)`)
        .bind(user.id, id, user.id, id),
    ]);
    if (!results[2].meta.changes) throw new ApiError(409, 'Only an unchanged note in trash can be permanently deleted.');
    publishNoteChanges(env, user.id, request);
    return json({ ok: true });
  }
  return null;
}
