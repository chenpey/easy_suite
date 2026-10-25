export interface ExternalChange {
  from: number;
  to: number;
  insert: string;
}

/** Lines beyond this bound fall back to one segment, which no longer preserves positions inside it. */
const MAX_DIFF_LINES = 200;
const MAX_DIFF_SEGMENTS = 200;

/**
 * Lines keep their terminating newline so "end of line" and "end of note" never compare equal: appending a
 * final line changes the separator of the line before it, and that separator is part of the changed region.
 */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function lineOffsets(lines: string[]): number[] {
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length);
  return offsets;
}

/** Longest-common-subsequence alignment of the changed lines; unchanged lines become anchors. */
function alignLines(a: string[], b: string[]): [number, number][] {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Trims the common head and tail of one replaced region so a small edit maps as a small change. */
function refine(current: string, from: number, to: number, insert: string): ExternalChange {
  const replaced = current.slice(from, to);
  let start = 0;
  const limit = Math.min(replaced.length, insert.length);
  while (start < limit && replaced[start] === insert[start]) start++;
  let endReplaced = replaced.length;
  let endInsert = insert.length;
  while (endReplaced > start && endInsert > start && replaced[endReplaced - 1] === insert[endInsert - 1]) {
    endReplaced--;
    endInsert--;
  }
  return { from: from + start, to: from + endReplaced, insert: insert.slice(start, endInsert) };
}

/**
 * Changes that turn `current` into `next` without touching unchanged lines, so selection, insertion markers and
 * undo inside the untouched middle of the note keep their positions. Line anchors are found first and each
 * changed region is then narrowed to its changed characters.
 *
 * Known limitation: more than `MAX_DIFF_LINES` changed lines (or `MAX_DIFF_SEGMENTS` regions) fall back to one
 * region for the whole changed span; that region still replaces only the changed span, never the whole note,
 * but positions inside it collapse to its start.
 */
export function externalChanges(current: string, next: string): ExternalChange[] {
  if (current === next) return [];
  const a = splitLines(current);
  const b = splitLines(next);
  const aOffsets = lineOffsets(a);
  const bOffsets = lineOffsets(b);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const whole = () => [refine(current, aOffsets[head], aOffsets[a.length - tail], next.slice(bOffsets[head], bOffsets[b.length - tail]))];
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (!midA.length && !midB.length) return [];
  if (midA.length > MAX_DIFF_LINES || midB.length > MAX_DIFF_LINES) return whole();

  const changes: ExternalChange[] = [];
  let i = 0;
  let j = 0;
  const region = (endA: number, endB: number) => {
    if (i === endA && j === endB) return;
    changes.push(refine(current, aOffsets[head + i], aOffsets[head + endA], next.slice(bOffsets[head + j], bOffsets[head + endB])));
    i = endA;
    j = endB;
  };
  for (const [anchorA, anchorB] of alignLines(midA, midB)) {
    region(anchorA, anchorB);
    i = anchorA + 1;
    j = anchorB + 1;
  }
  region(midA.length, midB.length);
  const useful = changes.filter((change) => change.to > change.from || change.insert.length > 0);
  return useful.length > MAX_DIFF_SEGMENTS ? whole() : useful;
}
