import assert from 'node:assert/strict';
import test from 'node:test';
import MarkdownIt from 'markdown-it';
import { EditorState, type ChangeSpec } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { Strikethrough, Table, TaskList } from '@lezer/markdown';
import { markdownMath } from '../src/client/math';
import { livePreviewActive, livePreviewMode, livePreviewState, setPlanEffect } from '../src/client/livePreview';
import {
  analyzeLiveMarkdown, analyzeLiveMarkdownSteps, scanDetailsSteps, snippetContainers, snippetParser,
  snippetScanContext, textLines, type LiveMarkdownPlan, type LivePlanSeed,
} from '../src/client/livePreviewSyntax';
import { markdownTarget, privateFileId, privateImageId, safeMarkdownHref } from '../src/client/markdownResources';

const liveMarkdown = () => markdown({ extensions: [Table, TaskList, Strikethrough] });

function documentState(doc: string) {
  const state = EditorState.create({
    doc,
    extensions: [livePreviewMode.of('live'), livePreviewActive.of(true), livePreviewState, liveMarkdown()],
  });
  // The editor parses in the background; a plan only ever describes the range the parser finished.
  ensureSyntaxTree(state, state.doc.length, 60000);
  return state;
}

/** The seed the controller builds: the plan the field mapped onto the document plus the region it dropped. */
function seedOf(state: EditorState): LivePlanSeed | undefined {
  const value = state.field(livePreviewState);
  return value.plan && value.plan.doc === state.doc && value.dirty.length
    ? { plan: value.plan, dirty: value.dirty }
    : undefined;
}

function installed(state: EditorState, plan: LiveMarkdownPlan) {
  return state.update({ effects: setPlanEffect.of(plan) }).state;
}

/** Mirrors one editor step: the plan of the previous state is installed, the change applied, the plan computed. */
function type(state: EditorState, plan: LiveMarkdownPlan, changes: ChangeSpec) {
  const next = installed(state, plan).update({ changes }).state;
  ensureSyntaxTree(next, next.doc.length, 60000);
  return { state: next, plan: analyzeLiveMarkdown(next, seedOf(next)) };
}

/** Compares descriptions only: a mapped block spells its optional fields out as undefined. */
function withoutUndefined<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function describeBlocks(plan: LiveMarkdownPlan) {
  return plan.blocks.map((block) => withoutUndefined({
    ...block, inline: block.inline.map((span) => withoutUndefined({ ...span })),
  }));
}

/** Everything a later plan reuses or trusts: blocks plus the ranges that decide where the next region starts. */
function describePlan(plan: LiveMarkdownPlan) {
  return {
    blocks: describeBlocks(plan),
    html: plan.html, math: plan.math, details: plan.details, openDetails: plan.openDetails, missing: plan.missing,
  };
}

const plain = [
  '开头段落。', '',
  '第二段有 **加粗** 和 `code`。', '',
  '- 列表项一', '- [ ] 待办', '  - 嵌套项', '',
  '> 引用段落', '',
  '| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |', '',
  '```js', 'const value = 1;', '```', '',
  '<details>', '<summary>折叠</summary>', '', '折叠正文', '', '</details>', '',
  '$$', '\\frac{a}{b}', '$$', '',
  '结尾段落。', '',
].join('\n');

test('a change re-describes its region and keeps every other block of the plan', () => {
  const state = documentState(plain);
  const plan = analyzeLiveMarkdown(state);
  const position = plain.indexOf('第二段') + 2;
  const { state: next, plan: incremental } = type(state, plan, { from: position, insert: '改' });
  assert.deepEqual(describePlan(incremental), describePlan(analyzeLiveMarkdown(next)));
  assert.equal(incremental.failure, null);
  // The untouched blocks are not visited again: the work follows the region, not the document.
  const seed = seedOf(next);
  assert.ok(seed);
  const full = drain(analyzeLiveMarkdownSteps(next));
  const region = drain(analyzeLiveMarkdownSteps(next, seed));
  assert.ok(region.steps * 2 < full.steps, `only the region is described (${region.steps} of ${full.steps} steps)`);
});

const scenarios: { name: string; doc: string; changes: ChangeSpec }[] = [
  { name: 'a paragraph', doc: plain, changes: { from: plain.indexOf('第二段') + 1, insert: '新' } },
  { name: 'a fence body', doc: plain, changes: { from: plain.indexOf('value = 1'), insert: '2' } },
  { name: 'a fence opener', doc: plain, changes: { from: plain.indexOf('```js'), insert: '`\n' } },
  { name: 'a fence closer', doc: plain, changes: { from: plain.indexOf('```\n\n<details>'), to: plain.indexOf('```\n\n<details>') + 3, insert: '' } },
  { name: 'a details opener', doc: plain, changes: { from: plain.indexOf('<details>'), insert: '<details>\n' } },
  { name: 'a details closer', doc: plain, changes: { from: plain.indexOf('</details>'), to: plain.indexOf('</details>') + 10, insert: '' } },
  { name: 'a block formula', doc: plain, changes: { from: plain.indexOf('\\frac'), insert: 'x' } },
  { name: 'a formula opener', doc: plain, changes: { from: plain.indexOf('$$'), to: plain.indexOf('$$') + 2, insert: '$$' } },
  { name: 'a table cell', doc: plain, changes: { from: plain.indexOf('| 1 |') + 2, insert: '9' } },
  { name: 'a list item', doc: plain, changes: { from: plain.indexOf('列表项一') + 1, insert: '新' } },
  { name: 'a task marker', doc: plain, changes: { from: plain.indexOf('- [ ]') + 2, to: plain.indexOf('- [ ]') + 5, insert: '[x]' } },
  { name: 'a blockquote', doc: plain, changes: { from: plain.indexOf('引用段落') + 1, insert: '新' } },
  { name: 'the first line', doc: plain, changes: { from: 0, insert: '标题\n' } },
  { name: 'the last line', doc: plain, changes: { from: plain.length - 1, insert: '新' } },
  { name: 'a deleted line', doc: plain, changes: { from: 0, to: plain.indexOf('\n') + 2, insert: '' } },
];

test('an incremental plan matches a full plan for changes anywhere in the note', () => {
  for (const scenario of scenarios) {
    const state = documentState(scenario.doc);
    const plan = analyzeLiveMarkdown(state);
    const { state: next, plan: incremental } = type(state, plan, scenario.changes);
    assert.deepEqual(describePlan(incremental), describePlan(analyzeLiveMarkdown(next)), scenario.name);
  }
});

test('typing into a raw HTML container keeps its structure', () => {
  const doc = [
    '<section>', '', '$$htmlInside$$', '', '<details>', '<summary>容器内折叠</summary>', '',
    '容器正文', '', '</details>', '', '</section>', '', '$$', 'x^2', '$$', '', '结尾。', '',
  ].join('\n');
  const state = documentState(doc);
  const plan = analyzeLiveMarkdown(state);
  const { state: next, plan: incremental } = type(state, plan, { from: doc.indexOf('容器正文') + 1, insert: '新' });
  assert.deepEqual(describePlan(incremental), describePlan(analyzeLiveMarkdown(next)));
  assert.equal(incremental.blocks.filter((block) => block.kind === 'details').length, 0);
});

test('a typing burst accumulates one region and still matches a full plan', () => {
  const state = documentState(plain);
  const plan = analyzeLiveMarkdown(state);
  // A burst never waits for the debounce: the installed plan keeps mapping while every change adds to `dirty`.
  let current = installed(state, plan);
  let position = plain.indexOf('第二段') + 1;
  for (const character of '连续输入十个字符') {
    current = current.update({ changes: { from: position, insert: character } }).state;
    ensureSyntaxTree(current, current.doc.length, 60000);
    position += character.length;
  }
  const seed = seedOf(current);
  assert.ok(seed, 'the mapped plan and its dirty region survive the burst');
  assert.deepEqual(describePlan(analyzeLiveMarkdown(current, seed)), describePlan(analyzeLiveMarkdown(current)));
});

/** A state whose background parse has only reached a prefix of the note, like the real editor on load. */
function prefixState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [livePreviewMode.of('live'), livePreviewActive.of(true), livePreviewState, liveMarkdown()],
  });
}

test('a prefix tree owes its undescribed tail and converges once the parse finishes', () => {
  const content = richDocument(64 * 1024);
  const state = prefixState(content);
  const first = analyzeLiveMarkdown(state);
  assert.ok(first.blocks.length > 0, 'the parsed prefix is described');
  assert.ok(first.missing.length > 0, 'the tail without syntax nodes is owed');
  assert.equal(first.missing.at(-1)!.to, content.length, 'the owed range reaches the end of the note');
  assert.ok(first.missing[0].from <= first.blocks.at(-1)!.to, 'the owed range covers the block the parser had not finished');

  const owedChars = (plan: LiveMarkdownPlan) =>
    plan.missing.reduce((total, range) => total + (range.to - range.from), 0);
  // An edit inside the owed tail describes its own region only. The part of the tail that region did not walk
  // has to stay owed, otherwise the remaining text would never be described again.
  const edited = installed(state, first).update({ changes: { from: content.length, insert: 'X' } }).state;
  ensureSyntaxTree(edited, edited.doc.length, 60000);
  const editedSeed = seedOf(edited);
  assert.ok(editedSeed);
  const afterEdit = analyzeLiveMarkdown(edited, editedSeed);
  assert.ok(owedChars(afterEdit) > owedChars(first) * 0.9,
    `an edit inside the tail keeps the rest owed (${owedChars(afterEdit)} of ${owedChars(first)})`);

  // The background parse advances; the language field publishes a new tree snapshot in a transaction.
  ensureSyntaxTree(edited, edited.doc.length, 60000);
  const advanced = edited.update({}).state;
  let current = installed(advanced, afterEdit);
  // The controller describes owed work in bounded chunks until nothing is left.
  for (let round = 0; round < 64; round++) {
    const value = current.field(livePreviewState);
    assert.ok(value.plan);
    if (!value.plan.missing.length) break;
    const next = analyzeLiveMarkdown(current, { plan: value.plan, dirty: value.plan.missing, owed: value.dirty.length === 0 });
    current = installed(current, next);
  }
  const plan = current.field(livePreviewState).plan!;
  assert.deepEqual(plan.missing, [], 'every chunk of the tail was described');
  assert.deepEqual(describePlan(plan), describePlan(analyzeLiveMarkdown(current)));
  // The last block of the note is really rendered by the plan, not merely missing from its failure list.
  assert.ok(plan.blocks.some((block) => block.kind === 'details' && block.to > current.doc.length - 200));
});

test('an owed chunk never stops inside a long code block on its way to the tail', () => {
  // The fence is longer than one owed chunk but still describable as a single code widget, with a heading after
  // it. A chunk boundary inside the fence used to describe the whole fence while only claiming its first part, so
  // the next chunk started at the same boundary and the tail below it stayed source forever.
  const body = Array.from({ length: 900 }, (_, index) => `const line${index} = ${index};`).join('\n');
  const fence = `\`\`\`js\n${body}\n\`\`\``;
  assert.ok(fence.length > 16_384 && fence.length < 50_000, `the sample fits one code widget (${fence.length})`);
  const content = ['开头段落。', '', fence, '', '## 尾标题', '', '尾部段落。', ''].join('\n');

  const state = prefixState(content);
  const first = analyzeLiveMarkdown(state);
  assert.ok(first.missing.length > 0, 'the initial plan has not reached the fence yet');
  ensureSyntaxTree(state, state.doc.length, 60000);

  let current = installed(state, first);
  const owedChars = (plan: LiveMarkdownPlan) =>
    plan.missing.reduce((total, range) => total + (range.to - range.from), 0);
  let owed = owedChars(first);
  for (let round = 0; round < 16; round++) {
    const value = current.field(livePreviewState);
    assert.ok(value.plan);
    if (!value.plan.missing.length) break;
    const next = analyzeLiveMarkdown(current, { plan: value.plan, dirty: value.plan.missing, owed: value.dirty.length === 0 });
    current = installed(current, next);
    const remaining = owedChars(next);
    assert.ok(remaining < owed, `every owed chunk makes progress (${remaining} of ${owed})`);
    owed = remaining;
  }
  const plan = current.field(livePreviewState).plan!;
  assert.deepEqual(plan.missing, [], 'the tail after the long fence was described');
  assert.ok(plan.blocks.some((block) => block.kind === 'code' && block.language === 'js' && block.to < current.doc.length));
  assert.ok(plan.blocks.some((block) => block.kind === 'heading' && block.text.includes('尾标题')));
  assert.deepEqual(describePlan(plan), describePlan(analyzeLiveMarkdown(current)));
});

test('an unclosed ancestor still owns a closing tag added below a closed inner block', () => {
  const doc = [
    '<details>', '<summary>外层</summary>', '',
    '<details open>', '<summary>内层</summary>', '', '内层正文', '', '</details>', '',
    '中间段落。', '',
    '结尾段落。', '',
  ].join('\n');
  const state = documentState(doc);
  const plan = analyzeLiveMarkdown(state);
  // Only the inner block closes; the unclosed outer opener is remembered for what its region has to re-read.
  assert.equal(plan.blocks.filter((block) => block.kind === 'details').length, 1);
  assert.deepEqual(plan.openDetails.map((range) => range.from), [0]);

  const appended = installed(state, plan).update({ changes: { from: doc.length, insert: '</details>\n' } }).state;
  ensureSyntaxTree(appended, appended.doc.length, 60000);
  const seed = seedOf(appended);
  assert.ok(seed, 'the appended closing tag is described again');
  const incremental = analyzeLiveMarkdown(appended, seed);
  assert.deepEqual(describePlan(incremental), describePlan(analyzeLiveMarkdown(appended)));
  // The inner block is not kept as an independent widget: the same closing tag decides the outer structure.
  const outer = incremental.blocks.filter((block) => block.kind === 'details');
  assert.equal(outer.length, 1);
  assert.equal(outer[0].from, 0);
  assert.ok(outer[0].text.includes('中间段落。'));
  assert.deepEqual(incremental.openDetails, []);
});

test('block math keeps a leading minus inside the formula instead of stripping it as a list marker', () => {
  const reading = new MarkdownIt().use(markdownMath);
  const readingTex = (source: string) => reading.parse(source, {}).flatMap((token) =>
    token.type === 'math_block' ? [token] : (token.children ?? []).filter((item) => item.type === 'math_inline'))
    .map((token) => token.content);
  const samples = [
    // A top-level formula whose TeX starts with a minus.
    '$$\n- x\n$$',
    // The same minus inside a quote and inside a list item: only the container prefix may be removed.
    '> $$\n> - x\n> $$',
    '- $$\n  - x\n  $$',
    // A formula whose whole body is a list-looking expression stays intact.
    '$$\n- a + b\n- c\n$$',
  ];
  for (const source of samples) {
    const plan = analyzeLiveMarkdown(documentState(source));
    const blocks = plan.blocks.filter((block) => block.kind === 'math');
    assert.equal(blocks.length, 1, source);
    assert.equal(blocks[0].mathTex, readingTex(source)[0], source);
  }
});

test('raw HTML containers ignore comment and quote pseudo tags and cover common block tags', () => {
  const container = (open: string, close: string) => [
    open, '', '<!-- </section> -->', '',
    '<details open>', '<summary>容器内折叠</summary>', '', '容器正文', '', '</details>', '',
    close, '', '结尾段落。', '',
  ].join('\n');
  const samples = [
    container('<section>', '</section>'),
    // A quoted `</section>` inside the opening tag is an attribute value, not a closing tag.
    container('<section data-probe="</section>">', '</section>'),
    // Block containers the fixed set used to miss: the details inside stays literal source.
    container('<dl>', '</dl>'),
    container('<h1>', '</h1>'),
    container('<menu>', '</menu>'),
  ];
  for (const source of samples) {
    const plan = analyzeLiveMarkdown(documentState(source));
    assert.equal(plan.blocks.filter((block) => block.kind === 'details').length, 0, source);
    assert.equal(plan.openDetails.length, 0, source);
    const inner = source.indexOf('<details open>');
    assert.ok(plan.html.some((range) => range.from <= inner && range.to >= source.indexOf('</details>')),
      `the container covers the block inside it (${source.slice(0, 20)})`);
  }
});

test('a recognised HTML container keeps its ordinary Markdown blocks as source', () => {
  const doc = [
    '<section>', '',
    '容器内 **强调**、`代码`、$x^2$ 与 [[0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f|链接]]', '',
    '- [ ] 容器内任务', '',
    '```js', 'const inside = 1;', '```', '',
    '<details open>', '<summary>容器内折叠</summary>', '', '容器内正文', '', '</details>', '',
    '</section>', '',
    '## 容器之后', '',
    '段落 **强调**。', '',
  ].join('\n');
  const plan = analyzeLiveMarkdown(documentState(doc));
  const close = doc.indexOf('</section>') + '</section>'.length;
  assert.deepEqual(plan.blocks.filter((block) => block.from < close).map((block) => block.kind), []);
  // The details inside the container is not enhanced either, so nothing but plain source is left above the close.
  assert.equal(plan.blocks.filter((block) => block.kind === 'details').length, 0);
  // Blocks after the container are still described normally, inline marks included.
  assert.ok(plan.blocks.some((block) => block.kind === 'heading' && block.text.includes('容器之后')));
  assert.ok(plan.blocks.some((block) => block.kind === 'paragraph' && block.text.includes('段落 **强调**')));
});

test('a snippet scan covers the same recognised container the note plan does', () => {
  // The widget DOM builds a details body from a snippet; its container coverage has to match the note plan, so a
  // recognised container inside the body stays literal source there as well.
  const body = [
    '前言。', '',
    '<section>', '',
    '容器内 **强调**', '',
    '</section>', '',
    '容器外 **强调**', '',
  ].join('\n');
  const containers = snippetContainers(body);
  // Reusing a parse the caller already made produces exactly the coverage of a fresh scan.
  assert.deepEqual(snippetContainers(body, snippetParser.parse(body).topNode), containers);
  const inner = body.indexOf('容器内 **强调**');
  const outer = body.indexOf('容器外 **强调**');
  assert.ok(containers.some((range) => range.from <= inner && range.to > inner), 'the container covers its own paragraph');
  assert.ok(!containers.some((range) => range.from <= outer && range.to > outer), 'the block after the container is outside');
});

function richBlock(index: number) {
  return [
    `## 章节 ${index}`, '',
    `这一段包含 **加粗 ${index}**、*斜体*、~~删除~~、\`code-${index}\` 和 [相对链接](/x/${index}) 以及行内公式 $a_${index}^2$。`, '',
    `- 列表项 ${index}`, `- [ ] 待办 ${index}`, `  - 嵌套项 ${index}`, '',
    `> 引用第 ${index} 段`, '',
    `| 列甲 ${index} | 列乙 |`, '| --- | --- |', `| 值 ${index} | 值二 |`, '',
    '```js', `const value${index} = ${index};`, '```', '',
    '---', '',
    '<details>', `<summary>折叠 ${index}</summary>`, '', `折叠正文 ${index}`, '', '</details>', '',
  ].join('\n');
}

function richDocument(target: number) {
  let text = '';
  for (let index = 0; ; index++) {
    const block = richBlock(index);
    if (Buffer.byteLength(text + block, 'utf8') > target) return text;
    text += block;
  }
}

function drain(iterator: Generator<void, LiveMarkdownPlan>) {
  let steps = 0;
  let step = iterator.next();
  while (!step.done) { steps++; step = iterator.next(); }
  return { plan: step.value, steps };
}

test('one keystroke in a 256 KiB note re-describes a bounded region instead of the whole document', () => {
  const content = richDocument(256 * 1024 - 128);
  assert.ok(Buffer.byteLength(content, 'utf8') > 250 * 1024, 'the sample stays at the runtime note limit');
  const state = documentState(content);
  const plan = analyzeLiveMarkdown(state);
  assert.equal(plan.failure, null);
  assert.ok(plan.blocks.length > 500, `the sample plan covers many blocks (${plan.blocks.length})`);

  const position = content.lastIndexOf('折叠正文');
  assert.ok(position > 0);
  const next = installed(state, plan).update({ changes: { from: position, insert: '新' } }).state;
  const seed = seedOf(next);
  assert.ok(seed);
  const incremental = drain(analyzeLiveMarkdownSteps(next, seed));
  // The keystroke stays inside the analysis budget: no whole-document pass, so no 'budget' fallback.
  assert.equal(incremental.plan.failure, null);
  assert.ok(incremental.steps < 200, `a keystroke only touches its own region (${incremental.steps} steps)`);
  assert.ok(incremental.plan.blocks.length >= plan.blocks.length,
    `every block outside the region is reused (${incremental.plan.blocks.length} of ${plan.blocks.length})`);
  assert.ok(incremental.plan.blocks.some((block) => block.text.includes('新')), 'the edited block is described again');
});

test('a quoted fence keeps every code line of the quote', () => {
  // A fence continued across quote or list lines is split into one `CodeText` per line with the container's own
  // marks between them; the block body is all of them, so no line is silently dropped from the widget.
  const doc = [
    '> ```js', '> const first = 1;', '>', '> const second = 2;', '> ```', '',
    '- 列表项', '', '  ```js', '  listFirst', '', '  listSecond', '  ```', '',
  ].join('\n');
  const plan = analyzeLiveMarkdown(documentState(doc));
  assert.deepEqual(plan.blocks.filter((block) => block.kind === 'code').map((block) => block.codeText), [
    'const first = 1;\n\nconst second = 2;',
    'listFirst\n\nlistSecond',
  ]);
});

test('a details body stays one contiguous slice of its source', () => {
  const doc = [
    '前言。', '',
    '<details open>', '<summary>正文标题</summary>', '',
    '> - [ ] 引用待办', '',
    '</details>', '',
    '<details open>', '前言正文', '<summary>后置标题</summary>', '', '</details>', '',
  ].join('\n');
  const iterator = scanDetailsSteps(textLines(doc), snippetScanContext(doc));
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  const [first, second] = step.value.ranges;
  // The body is not rewritten: it is the document slice from `bodyFrom`, so a task inside it can name its own
  // absolute offset instead of a position inside the snippet.
  assert.equal(doc.slice(first.bodyFrom, first.bodyFrom + first.body.length), first.body);
  assert.equal(first.summary, '正文标题');
  assert.ok(first.body.includes('> - [ ] 引用待办'), 'the body keeps its own Markdown');
  // Only a summary that opens the body is that block's header; anything else stays literal body text.
  assert.equal(second.summary, '');
  assert.ok(second.body.includes('<summary>后置标题</summary>'), 'a later summary is not cut out of the body');
  assert.equal(doc.slice(second.bodyFrom, second.bodyFrom + second.body.length), second.body);
});

test('a Markdown target keeps one value with and without its angle-bracket shell', () => {
  const validate = (href: string) => MarkdownIt().validateLink(href);
  const absolute = 'https://example.com/path';
  const imageId = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
  // The shell is syntax: the same target is the same value, so the protocol check sees the scheme.
  assert.equal(markdownTarget(`<${absolute}>`), absolute);
  assert.equal(markdownTarget(absolute), absolute);
  assert.equal(markdownTarget('<user@example.com>'), 'user@example.com');
  assert.equal(safeMarkdownHref(`<${absolute}>`, validate), absolute);
  // Decoding happens before the whitelist, so a hidden or disguised scheme is still refused.
  assert.equal(markdownTarget('<java&#x73;cript:alert(1)>'), 'javascript:alert(1)');
  assert.equal(safeMarkdownHref('<javascript:alert(1)>', validate), null);
  assert.equal(safeMarkdownHref('<data:text/html,plain>', validate), null);
  // The private paths go through the same entry as the editor's link checks.
  assert.equal(privateImageId(`</api/images/${imageId}>`), imageId);
  assert.equal(privateFileId(`</api/files/${imageId}>`), imageId);
  assert.equal(privateImageId(`<https://example.com/api/images/${imageId}>`), null);
});
