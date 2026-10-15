import assert from 'node:assert/strict';
import test from 'node:test';
import MarkdownIt from 'markdown-it';
import { markdownMath } from '../src/client/math';

const md = new MarkdownIt().use(markdownMath);
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
