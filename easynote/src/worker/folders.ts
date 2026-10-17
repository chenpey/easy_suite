import { compareFolders, placePositions } from '../shared/order';
import { idPattern, MAX_FOLDER_DEPTH, MAX_FOLDERS, validPosition, type Folder } from '../shared/types';
import type { Identity } from './auth';
import { ApiError, json, readJson, type Env } from './core';
import { publishNoteChanges } from './events';

export interface FolderRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
}

export const toFolder = (row: FolderRow): Folder => ({
  id: row.id, name: row.name, parentId: row.parent_id, position: row.position,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

export async function loadFolder(env: Env, userId: string, id: string): Promise<FolderRow | null> {
  return env.DB.prepare('SELECT * FROM folders WHERE id=? AND user_id=?').bind(id, userId).first<FolderRow>();
}

// Depth of an existing folder, or null when it is missing or already corrupt.
async function folderDepth(env: Env, userId: string, id: string): Promise<number | null> {
  let depth = 0;
  let current: string | null = id;
  while (current) {
    const row: { parent_id: string | null } | null = await env.DB.prepare('SELECT parent_id FROM folders WHERE id=? AND user_id=?')
      .bind(current, userId).first<{ parent_id: string | null }>();
    if (!row) return null;
    depth++;
    if (depth > MAX_FOLDER_DEPTH) return null;
    current = row.parent_id;
  }
  return depth;
}

// Depth of every folder below `id`, keyed by ID; null when the folder is missing. One snapshot keeps
// the walk bounded even on a legacy tree that still contains a cycle.
async function subtreeDepths(env: Env, userId: string, id: string): Promise<Map<string, number> | null> {
  const rows = await env.DB.prepare('SELECT id,parent_id FROM folders WHERE user_id=?')
    .bind(userId).all<{ id: string; parent_id: string | null }>();
  if (!rows.results.some((row) => row.id === id)) return null;
  const children = new Map<string, string[]>();
  for (const row of rows.results) {
    if (!row.parent_id) continue;
    children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row.id]);
  }
  const depths = new Map<string, number>([[id, 0]]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const child of children.get(current) ?? []) {
        if (depths.has(child)) continue;
        depths.set(child, (depths.get(current) ?? 0) + 1);
        next.push(child);
      }
    }
    frontier = next;
  }
  return depths;
}

function folderName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'Invalid folder name.');
  const name = value.trim();
  if (!name || name.length > 64 || /[\u0000-\u001f]/.test(name)) {
    throw new ApiError(400, 'Folder name must be 1-64 characters.');
  }
  return name;
}

function parentId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !idPattern.test(value)) throw new ApiError(400, 'Invalid parent folder ID.');
  return value;
}

// Null means "no anchor", which appends the folder behind its new siblings.
function anchorId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !idPattern.test(value)) throw new ApiError(400, 'Invalid anchor folder ID.');
  return value;
}

function onlyKeys(data: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(data).some((key) => !keys.includes(key))) throw new ApiError(400, 'Invalid folder fields.');
}

export async function folderRoutes(
  request: Request,
  env: Env,
  user: Identity,
  path: string,
): Promise<Response | null> {
  if (path === '/api/folders' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM folders WHERE user_id=? ORDER BY position,name,id')
      .bind(user.id).all<FolderRow>();
    return json({ folders: rows.results.map(toFolder).sort(compareFolders) });
  }
  if (path === '/api/folders' && request.method === 'POST') {
    const data = await readJson(request, 2048);
    onlyKeys(data, ['id', 'name', 'parentId', 'position']);
    const id = data.id;
    if (typeof id !== 'string' || !idPattern.test(id)) throw new ApiError(400, 'Invalid folder ID.');
    // Only a create may carry an explicit order key; a move computes its own key so the archive order
    // is restored without letting a stale client drop a folder into an arbitrary slot.
    if (!(data.position === undefined || validPosition(data.position))) throw new ApiError(400, 'Invalid folder position.');
    const name = folderName(data.name);
    const parent = parentId(data.parentId);
    const existing = await loadFolder(env, user.id, id);
    if (existing) {
      if (existing.name === name && existing.parent_id === parent) return json({ folder: toFolder(existing) });
      throw new ApiError(409, 'Folder ID already used by another folder.');
    }
    if (parent !== null) {
      const depth = await folderDepth(env, user.id, parent);
      if (depth === null) throw new ApiError(400, 'Parent folder not found.');
      if (depth + 1 > MAX_FOLDER_DEPTH) throw new ApiError(400, `Folders support at most ${MAX_FOLDER_DEPTH} levels.`);
    }
    const time = Date.now();
    // Guard and insert in one statement so a concurrent sibling with the same name cannot double-write.
    // The primary key is global, so an ID owned by another account must conflict instead of failing on UNIQUE.
    const written = await env.DB.prepare(`INSERT INTO folders(id,user_id,parent_id,name,position,created_at,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE (? IS NULL OR EXISTS(SELECT 1 FROM folders WHERE id=? AND user_id=?))
      AND NOT EXISTS(SELECT 1 FROM folders WHERE id=?)
      AND (SELECT COUNT(*) FROM folders WHERE user_id=?)<${MAX_FOLDERS}
      AND NOT EXISTS(SELECT 1 FROM folders WHERE user_id=? AND parent_id IS ? AND name=?) RETURNING *`)
      .bind(id, user.id, parent, name, data.position ?? 0, time, time, parent, parent, user.id, id, user.id, user.id, parent, name).first<FolderRow>();
    if (!written) {
      if (await env.DB.prepare('SELECT user_id FROM folders WHERE id=?').bind(id).first()) {
        throw new ApiError(409, 'Folder ID already used by another folder.');
      }
      if (parent !== null && await folderDepth(env, user.id, parent) === null) throw new ApiError(400, 'Parent folder not found.');
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM folders WHERE user_id=?')
        .bind(user.id).first<{ count: number }>();
      if ((count?.count ?? 0) >= MAX_FOLDERS) throw new ApiError(409, `Folder limit of ${MAX_FOLDERS} reached.`);
      throw new ApiError(409, 'A folder with this name already exists here.');
    }
    publishNoteChanges(env, user.id, request);
    return json({ folder: toFolder(written) }, 201);
  }
  const match = /^\/api\/folders\/([^/]+)$/.exec(path);
  if (!match) return null;
  const id = match[1];
  if (!idPattern.test(id)) throw new ApiError(404, 'Folder not found.');
  if (request.method === 'PATCH') {
    const data = await readJson(request, 1024);
    onlyKeys(data, ['name', 'parentId', 'afterId', 'beforeId']);
    const rename = Object.hasOwn(data, 'name');
    const move = Object.hasOwn(data, 'parentId');
    const afterId = anchorId(data.afterId);
    const beforeId = anchorId(data.beforeId);
    if (!rename && !move && !afterId && !beforeId) throw new ApiError(400, 'Invalid folder fields.');
    if (afterId && beforeId) throw new ApiError(400, 'Provide at most one anchor folder.');
    const existing = await loadFolder(env, user.id, id);
    if (!existing) throw new ApiError(404, 'Folder not found.');
    const name = rename ? folderName(data.name) : existing.name;
    const parent = move ? parentId(data.parentId) : existing.parent_id;
    if (afterId === id || beforeId === id) throw new ApiError(400, 'A folder cannot be anchored to itself.');
    if (move && parent !== existing.parent_id) {
      const depths = await subtreeDepths(env, user.id, id);
      if (!depths) throw new ApiError(404, 'Folder not found.');
      const height = Math.max(...depths.values());
      let depth = 1;
      if (parent !== null) {
        const parentDepth = await folderDepth(env, user.id, parent);
        if (parentDepth === null) throw new ApiError(400, 'Parent folder not found.');
        if (depths.has(parent)) throw new ApiError(400, 'A folder cannot be moved into itself or its own subtree.');
        depth = parentDepth + 1;
      }
      if (depth + height > MAX_FOLDER_DEPTH) throw new ApiError(400, `Folders support at most ${MAX_FOLDER_DEPTH} levels.`);
    }
    // Only a real reparenting or an explicit anchor moves the folder inside its sibling list;
    // a plain rename keeps the current slot.
    const reorder = !!afterId || !!beforeId || parent !== existing.parent_id;
    const siblings = reorder
      ? (await env.DB.prepare('SELECT id,name,position FROM folders WHERE user_id=? AND parent_id IS ? AND id<>?')
          .bind(user.id, parent, id).all<{ id: string; name: string; position: number }>()).results.sort(compareFolders)
      : [];
    let index = siblings.length;
    if (afterId || beforeId) {
      const at = siblings.findIndex((row) => row.id === (afterId ?? beforeId));
      if (at < 0) throw new ApiError(400, 'Anchor folder not found in the target folder.');
      index = afterId ? at + 1 : at;
    }
    const positions = reorder ? placePositions(siblings, [id], index) : new Map<string, number>();
    const statements = [...positions]
      .filter(([folderId]) => folderId !== id)
      .map(([folderId, position]) => env.DB.prepare('UPDATE folders SET position=? WHERE id=? AND user_id=?')
        .bind(position, folderId, user.id));
    // Rename and move share one atomic statement: a concurrent writer cannot slip a sibling
    // duplicate, a foreign parent or a cycle in between the checks above and this update.
    statements.push(env.DB.prepare(`UPDATE folders AS target SET name=?,parent_id=?,position=?,updated_at=?
      WHERE target.id=? AND target.user_id=?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM folders WHERE id=? AND user_id=?))
      AND NOT EXISTS(SELECT 1 FROM folders WHERE user_id=? AND parent_id IS ? AND name=? AND id<>?)
      AND (? IS NULL OR NOT EXISTS(
        WITH RECURSIVE ancestors(id,depth) AS (
          SELECT ?,0 UNION ALL
          SELECT parent.parent_id,ancestors.depth+1 FROM folders parent JOIN ancestors ON parent.id=ancestors.id
          WHERE parent.parent_id IS NOT NULL AND ancestors.depth<${MAX_FOLDER_DEPTH}
        ) SELECT 1 FROM ancestors WHERE id=?
      )) RETURNING *`)
      .bind(name, parent, positions.get(id) ?? existing.position, Date.now(), id, user.id,
        parent, parent, user.id, user.id, parent, name, id, parent, parent, id));
    const results = await env.DB.batch(statements);
    const written = (results.at(-1)!.results as FolderRow[])[0];
    if (!written) {
      if (!await loadFolder(env, user.id, id)) throw new ApiError(404, 'Folder not found.');
      if (parent !== null && await folderDepth(env, user.id, parent) === null) throw new ApiError(400, 'Parent folder not found.');
      const depths = await subtreeDepths(env, user.id, id);
      if (parent !== null && depths?.has(parent)) throw new ApiError(400, 'A folder cannot be moved into itself or its own subtree.');
      throw new ApiError(409, 'A folder with this name already exists here.');
    }
    publishNoteChanges(env, user.id, request);
    return json({ folder: toFolder(written) });
  }
  if (request.method === 'DELETE') {
    // A single statement: a child folder or note created between check and delete
    // must never be cascaded away or silently moved to the root.
    const result = await env.DB.prepare(`DELETE FROM folders WHERE id=? AND user_id=?
      AND NOT EXISTS(SELECT 1 FROM folders WHERE user_id=? AND parent_id=?)
      AND NOT EXISTS(SELECT 1 FROM notes WHERE user_id=? AND folder_id=?)`)
      .bind(id, user.id, user.id, id, user.id, id).run();
    if (!result.meta.changes) {
      if (!await loadFolder(env, user.id, id)) throw new ApiError(404, 'Folder not found.');
      throw new ApiError(409, 'Only an empty folder without notes can be deleted.');
    }
    publishNoteChanges(env, user.id, request);
    return json({ ok: true });
  }
  return null;
}
