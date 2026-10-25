import assert from 'node:assert/strict';
import test from 'node:test';
import { ChangeSet, Text } from '@codemirror/state';
import { externalChanges } from '../src/client/textDiff';

const applied = (current: string, changes: ReturnType<typeof externalChanges>) =>
  ChangeSet.of(changes, current.length).apply(Text.of(current.split('\n'))).toString();

test('separated edits keep the untouched middle of the note in place', () => {
  const current = 'A\nMID\nZ';
  const next = 'AA\nMID\nZZ';
  const changes = externalChanges(current, next);
  assert.equal(changes.length, 2);
  const set = ChangeSet.of(changes, current.length);
  assert.equal(applied(current, changes), next);
  // The unchanged middle keeps its content after mapping, so a caret or insertion marker inside it stays there.
  assert.equal(next.slice(set.mapPos(2, -1), set.mapPos(5, 1)), 'MID');
  assert.deepEqual([2, 3, 4, 5].map((position) => set.mapPos(position, -1)), [3, 4, 5, 6]);
});

test('a single edit stays a single minimal change', () => {
  const changes = externalChanges('标题\n正文一\n正文二', '标题\n正文一改\n正文二');
  assert.equal(changes.length, 1);
  assert.equal(applied('标题\n正文一\n正文二', changes), '标题\n正文一改\n正文二');
});

test('inserting and removing whole lines maps only the changed lines', () => {
  const current = 'one\ntwo\nthree\nfour';
  const next = 'one\nnew\ntwo\nthree\nfour';
  const changes = externalChanges(current, next);
  assert.equal(applied(current, changes), next);
  assert.equal(ChangeSet.of(changes, current.length).mapPos(current.indexOf('three'), -1), next.indexOf('three'));
});

test('a very large rewrite falls back to one bounded region instead of the whole note', () => {
  const current = ['head', ...Array.from({ length: 400 }, (_, index) => `line ${index}`), 'tail'].join('\n');
  const next = ['head', ...Array.from({ length: 400 }, (_, index) => `changed ${index}`), 'tail'].join('\n');
  const changes = externalChanges(current, next);
  assert.equal(changes.length, 1);
  assert.ok(changes[0].from > 0 && changes[0].to < current.length, 'the unchanged head and tail are outside the change');
  assert.equal(applied(current, changes), next);
});

test('identical content needs no change', () => {
  assert.deepEqual(externalChanges('same\ncontent', 'same\ncontent'), []);
});

// Line anchors must not treat "end of line" and "end of note" as the same separator: appending or removing a
// final line (or only its newline) is a change to the last common line, not an insertion after it.
const endOfFilePairs: [string, string][] = [
  ['', 'A'],
  ['A', ''],
  ['A', 'A\nB'],
  ['A\nB', 'A'],
  ['A', 'A\n'],
  ['A\n', 'A'],
  ['x\ny', 'x\ny\nz'],
  ['a\nb', 'a\nb\nc\nd'],
  ['a\nb\nc\nd', 'a\nb'],
  ['a\nb', ''],
  ['', 'a\nb'],
  ['one\ntwo\n', 'one\ntwo\nthree'],
  ['one\ntwo', 'one\ntwo\n'],
];

test('end-of-file line and newline changes reproduce the next source exactly', () => {
  for (const [current, next] of endOfFilePairs) {
    const changes = externalChanges(current, next);
    for (const change of changes) {
      assert.ok(change.from >= 0 && change.from <= change.to && change.to <= current.length,
        `change stays inside ${JSON.stringify(current)}: ${JSON.stringify(changes)}`);
    }
    assert.equal(applied(current, changes), next,
      `externalChanges(${JSON.stringify(current)}, ${JSON.stringify(next)}) gave ${JSON.stringify(changes)}`);
  }
});

test('appending a line keeps the caret and insertion markers of the existing text', () => {
  const current = 'first\nsecond';
  const next = 'first\nsecond\nthird';
  const changes = externalChanges(current, next);
  assert.equal(applied(current, changes), next);
  const set = ChangeSet.of(changes, current.length);
  assert.deepEqual([0, 5, 12].map((position) => set.mapPos(position, -1)), [0, 5, 12]);
  assert.equal(set.mapPos(current.length, -1), current.length, 'the end of the old text stays before the new line');
});
