import type { Folder, NoteSummary } from './types';

// Position keys grow by ORDER_STEP so a drop can take a slot between two neighbours.
export const ORDER_STEP = 1024;

export const compareFolders = (
  left: { id: string; name: string; position: number },
  right: { id: string; name: string; position: number },
): number => left.position - right.position || left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id);

// Keys to write when `moving` lands at `index` of `ordered`, which must be the whole sibling
// list in display order. Only rows whose key changes are returned; an exhausted gap renumbers
// the group so the result always matches the requested order.
export function placePositions(
  ordered: Array<{ id: string; position: number }>,
  moving: string[],
  index: number,
): Map<string, number> {
  const movingSet = new Set(moving);
  const rest = ordered.filter((row) => !movingSet.has(row.id));
  const after = rest[index];
  const before = rest[index - 1];
  const lo = before ? before.position : after ? after.position - (moving.length + 1) * ORDER_STEP : 0;
  const hi = after ? after.position : lo + (moving.length + 1) * ORDER_STEP;
  const updates = new Map<string, number>();
  if (hi - lo >= moving.length + 1) {
    moving.forEach((id, offset) =>
      updates.set(id, lo + Math.floor((hi - lo) * (offset + 1) / (moving.length + 1))));
    return updates;
  }
  const known = new Map(ordered.map((row) => [row.id, row.position]));
  const full = [...rest.slice(0, index).map((row) => row.id), ...moving, ...rest.slice(index).map((row) => row.id)];
  full.forEach((id, offset) => {
    const position = (offset + 1) * ORDER_STEP;
    if (movingSet.has(id) || known.get(id) !== position) updates.set(id, position);
  });
  return updates;
}
type FolderListEntry = { kind: 'folder'; item: Folder } | { kind: 'note'; item: NoteSummary };

export function mixFolderEntries(notes: NoteSummary[], folders: Folder[], manual: boolean, hasMoreNotes: boolean): FolderListEntry[] {
  const entries: FolderListEntry[] = [
    ...folders.map((item) => ({ kind: 'folder' as const, item })),
    ...notes.map((item) => ({ kind: 'note' as const, item })),
  ];
  entries.sort((left, right) =>
    Number(right.kind === 'note' && right.item.pinned) - Number(left.kind === 'note' && left.item.pinned) ||
    (manual ? left.item.position - right.item.position : 0) ||
    right.item.updatedAt - left.item.updatedAt || left.item.id.localeCompare(right.item.id));
  // Older folders wait for the next note page, so unloaded newer notes cannot be skipped.
  while (hasMoreNotes && entries.at(-1)?.kind === 'folder') entries.pop();
  return entries;
}
