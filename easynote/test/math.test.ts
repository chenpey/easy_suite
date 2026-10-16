import assert from 'node:assert/strict';
import test from 'node:test';
import MarkdownIt from 'markdown-it';
import { markdownMath } from '../src/client/math';
import { ORDER_STEP, placePositions } from '../src/shared/order';

const md = new MarkdownIt().use(markdownMath);
type Row = { id: string; position: number };
const rowsOf = (...positions: number[]): Row[] => positions.map((position, index) => ({ id: `n${index}`, position }));
// Re-orders like the server does, keeping the previous display order for equal keys.
const applied = (rows: Row[], updates: Map<string, number>, order: string[]): string[] => {
  const rank = new Map(order.map((id, index) => [id, index]));
  return rows.map((row) => ({ ...row, position: updates.get(row.id) ?? row.position }))
    .sort((left, right) => left.position - right.position || rank.get(left.id)! - rank.get(right.id)!)
    .map((row) => row.id);
};
const formulas = (source: string) => md.parse(source, {}).flatMap((token) =>
  token.type === 'math_block' ? [token] : (token.children ?? []).filter((item) => item.type === 'math_inline'));

test('math preserves TeX before Markdown interprets underscores, escapes and HTML', () => {
  const source = String.raw`公式 $a_b + c_d < \frac{1}{2}$，以及 $x^2$。`;
  assert.deepEqual(formulas(source).map((token) => token.content), [String.raw`a_b + c_d < \frac{1}{2}`, 'x^2']);
  assert.match(md.render(source), /&lt;/);
});

test('CommonMark bracket escapes stay literal so existing notes do not change', () => {
  assert.equal(formulas(String.raw`\[1\] and \(a\)`).length, 0);
  assert.equal(md.render(String.raw`\[1\] and \(a\)`).trim(), '<p>[1] and (a)</p>');
});

test('display formulas retain blank lines and source positions', () => {
  const source = String.raw`正文

$$
\begin{aligned}
a &= b \\

c &= d
\end{aligned}
$$

$$x^2 + y^2$$`;
  const parsed = formulas(source);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].map, [2, 9]);
  assert.ok(parsed.every((token) => token.block && token.meta.display));
  assert.match(parsed[0].content, /a &= b/);
  assert.equal(formulas('> $$\n> x^2\n> $$')[0].content, 'x^2');
});

test('code, escaped dollars, currency and incomplete delimiters stay literal', () => {
  for (const source of ['`$x$`', '```tex\n$x$\n```', String.raw`\$x\$`, '$20 and $30', '$ unfinished', '$$\nx + y']) {
    assert.equal(formulas(source).length, 0, source);
  }
});

test('escaped delimiters and braces do not prematurely close formulas', () => {
  assert.deepEqual(formulas(String.raw`$\text{a \$ b} + x$`).map((token) => token.content), [String.raw`\text{a \$ b} + x`]);
});

test('malformed openers have bounded parsing cost and do not affect the next document', () => {
  const start = performance.now();
  for (const source of ['${'.repeat(131072), '$$ {\n'.repeat(32768)]) {
    assert.equal(formulas(source).length, 0);
  }
  assert.ok(performance.now() - start < 1500, 'Malformed input blocked parsing for over 1.5 seconds');
  assert.equal(formulas('$x^2$')[0].content, 'x^2');
  assert.equal(formulas('$x^2$ '.repeat(10000)).length, 10000);
});

test('block and inline formulas share the same size limit', () => {
  const content = 'x'.repeat(10001);
  assert.equal(formulas(`$${content}$`).length, 0);
  assert.equal(formulas(`$$\n${content}\n$$`).length, 0);
  assert.equal(formulas('$$\nx^2\n$$')[0].content, 'x^2');
});

test('a first drag between untouched notes keeps the order and gives a real key', () => {
  const rows = rowsOf(0, 0, 0, 0);
  const updates = placePositions(rows, ['n3'], 0);
  assert.equal(updates.size, 1);
  assert.equal(updates.get('n3'), -ORDER_STEP);
  assert.deepEqual(applied(rows, updates, ['n0', 'n1', 'n2', 'n3']), ['n3', 'n0', 'n1', 'n2']);
});

test('a drop between two close notes renumbers the group and lands in place', () => {
  const rows = rowsOf(ORDER_STEP, ORDER_STEP + 1, 3 * ORDER_STEP);
  const updates = placePositions(rows, ['n2'], 1);
  assert.deepEqual([...updates], [['n2', 2 * ORDER_STEP], ['n1', 3 * ORDER_STEP]]);
  assert.deepEqual(applied(rows, updates, ['n0', 'n1', 'n2']), ['n0', 'n2', 'n1']);
});

test('dropping a selection keeps the dragged order at the head, middle and end', () => {
  const rows = rowsOf(0, 0, 0);
  const head = placePositions(rows, ['n2', 'n1'], 0);
  assert.deepEqual(applied(rows, head, ['n0', 'n1', 'n2']), ['n2', 'n1', 'n0']);

  const spread = rowsOf(ORDER_STEP, 2 * ORDER_STEP, 3 * ORDER_STEP);
  const middle = placePositions(spread, ['n2'], 1);
  assert.equal(middle.get('n2'), 1.5 * ORDER_STEP);
  assert.deepEqual(applied(spread, middle, ['n0', 'n1', 'n2']), ['n0', 'n2', 'n1']);

  const end = placePositions(spread, ['n0', 'n1'], 1);
  assert.deepEqual(applied(spread, end, ['n0', 'n1', 'n2']), ['n2', 'n0', 'n1']);
});
