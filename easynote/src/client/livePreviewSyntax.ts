import type { EditorState, Text } from '@codemirror/state';
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { parser as markdownParser, Strikethrough, Table, TaskList } from '@lezer/markdown';
import { idPattern } from '../shared/types';
import { MAX_FORMULA_LENGTH, mathContentValid, mathEnd } from './math';

export type LiveBlockKind = 'heading' | 'paragraph' | 'list' | 'task' | 'code' | 'table' | 'math' | 'details' | 'rule' | 'image';

export interface LiveInlineSpan {
  kind: 'math' | 'wikilink';
  from: number;
  to: number;
  tex?: string;
  display?: boolean;
  noteId?: string;
  label?: string;
}

export interface LiveTableData {
  align: ('left' | 'center' | 'right' | null)[];
  head: string[];
  rows: string[][];
}

export interface LiveBlock {
  kind: LiveBlockKind;
  /** Source offsets; block-level widgets always start at a line start and end at a line end. */
  from: number;
  to: number;
  /** 0-based source line of `from`. */
  line: number;
  endLine: number;
  headingLevel: number;
  listDepth: number;
  quoteDepth: number;
  /** True when the inactive block is replaced by a block widget instead of being styled in place. */
  block: boolean;
  /** Source that must stay literal (code fences without a renderable language); no inline marks apply. */
  source?: boolean;
  /** Exact source slice, used as widget identity. */
  text: string;
  language?: string;
  /** Fence body without the markers, used as the code widget's text. */
  codeText?: string;
  table?: LiveTableData;
  mathTex?: string;
  details?: { open: boolean; summary: string; body: string; bodyFrom: number };
  inline: LiveInlineSpan[];
}

export interface LiveMarkdownPlan {
  doc: Text;
  docLength: number;
  blocks: LiveBlock[];
  /** Raw HTML coverage of the document, including containers whose closing tag is far below. */
  html: OffsetRange[];
  /** Block formulas and collapsible blocks as scanned, which is what a later region has to stay clear of. */
  math: OffsetRange[];
  details: OffsetRange[];
  /** Standalone `<details>` openers that never closed; each reaches the end of the note. */
  openDetails: OffsetRange[];
  /** Ranges the parser had not reached yet; they are described again as the background parse advances. */
  missing: OffsetRange[];
  failure: 'budget' | null;
}

const MAX_NODES = 50_000;
// Only block widgets are expensive to describe and lay out; in-place text blocks are bounded separately.
const MAX_WIDGETS = 2_000;
const MAX_BLOCKS = 20_000;
const MAX_DEPTH = 32;
const MAX_WIDGET_SOURCE = 50_000;
/** Characters of owed work one plan describes; a note the parser is still catching up on stays responsive. */
const MAX_OWED_CHARS = 16_384;
/** Character steps shared by every syntax scanner in one plan, so one bad opener cannot restart the budget. */
const MAX_SCAN_STEPS = 100_000;
export const MAX_PLAN_MILLISECONDS = 100;

export interface ScanBudget {
  nodes: number;
  blocks: number;
  widgets: number;
  steps: number;
  deadline: number;
  failure: 'budget' | null;
}

export function createScanBudget(deadline = performance.now() + MAX_PLAN_MILLISECONDS): ScanBudget {
  return { nodes: 0, blocks: 0, widgets: 0, steps: 0, deadline, failure: null };
}

function charge(budget: ScanBudget, nodes: number, steps: number): boolean {
  if (budget.failure) return false;
  budget.nodes += nodes;
  budget.steps += steps;
  if (budget.nodes > MAX_NODES || budget.steps > MAX_SCAN_STEPS || performance.now() > budget.deadline) {
    budget.failure = 'budget';
    return false;
  }
  return true;
}

const spendNode = (budget: ScanBudget) => charge(budget, 1, 0);

/** Line-addressed view of a document or of a substring; lets details/数学 scanning run on a nested body too. */
export interface LineSource {
  lines: number;
  text(line: number): string;
  start(line: number): number;
  /** 1-based line number that contains `position`. */
  lineAt(position: number): number;
  slice(from: number, to: number): string;
}

export function textLines(source: string): LineSource {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const lineAt = (position: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  return {
    lines: starts.length,
    text(line) {
      const from = starts[line - 1];
      const to = line < starts.length ? starts[line] - 1 : source.length;
      return source.slice(from, to);
    },
    start: (line) => starts[line - 1],
    lineAt,
    slice: (from, to) => source.slice(from, to),
  };
}

function docLines(doc: Text): LineSource {
  return {
    lines: doc.lines,
    text: (line) => doc.line(line).text,
    start: (line) => doc.line(line).from,
    lineAt: (position) => doc.lineAt(Math.min(position, doc.length)).number,
    slice: (from, to) => doc.sliceString(from, to),
  };
}

export interface DetailsRange {
  from: number;
  to: number;
  open: boolean;
  summary: string;
  body: string;
  /** Offset of the body's first character in the scanned source, so offsets inside it stay absolute. */
  bodyFrom: number;
}

export interface DetailsScan {
  ranges: DetailsRange[];
  /** Openers that never closed in this source; each one reaches the end of the scanned source. */
  unclosed: OffsetRange[];
}

interface MathRange {
  from: number;
  to: number;
  tex: string;
}

export interface ScanContext {
  /** Fenced or indented code lines never take part in the extra syntax scans. */
  code(line: number): boolean;
  /** The line is raw HTML, including every line up to the closing tag of a container element. */
  html(line: number): boolean;
  /** The line opens a raw HTML block, which is the only place a standalone `<details>` may begin. */
  htmlStart(line: number): boolean;
  /** The line is inside a raw HTML container such as `<section>`, which is never interpreted. */
  container(line: number): boolean;
  budget: ScanBudget;
}

export interface OffsetRange {
  from: number;
  to: number;
}

export function insideRanges(ranges: readonly OffsetRange[], position: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (position < range.from) high = middle - 1;
    else if (position >= range.to) low = middle + 1;
    else return true;
  }
  return false;
}

function mergeRanges(ranges: OffsetRange[]): OffsetRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: OffsetRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ from: range.from, to: range.to });
  }
  return merged;
}

interface HtmlScan {
  /** Raw HTML regions; a container covers everything up to its closing tag. */
  html: OffsetRange[];
  /** Raw HTML container elements only (`<section>`…), which never take part in the extra syntax. */
  containers: OffsetRange[];
  /** Lines that open a raw HTML block. */
  starts: Set<number>;
}

function scanContext(lines: LineSource, code: Set<number>, scan: HtmlScan, budget: ScanBudget): ScanContext {
  return {
    code: (line) => code.has(line),
    html: (line) => insideRanges(scan.html, lines.start(line)),
    htmlStart: (line) => scan.starts.has(line),
    container: (line) => insideRanges(scan.containers, lines.start(line)),
    budget,
  };
}

// Container elements are never interpreted: everything up to their closing tag stays literal source. `details` is
// deliberately absent, because our own collapsible syntax is rebuilt by the details scanner below.
const containerTags = new Set([
  'address', 'article', 'aside', 'audio', 'blockquote', 'button', 'canvas', 'center', 'dialog', 'div', 'dl', 'dt',
  'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'iframe', 'li', 'main', 'math', 'menu', 'nav', 'noscript', 'object', 'ol', 'p', 'pre', 'script', 'section', 'select',
  'style', 'svg', 'table', 'template', 'textarea', 'ul', 'video',
]);

const openTag = /^<([a-z][a-z0-9-]*)(?=[\s/>])/i;

interface LineTags {
  tags: HtmlTagToken[];
  /** Set when a comment opened on this line continues on the next one. */
  inComment: boolean;
}

interface HtmlTagToken {
  /** Offset of the `<` in the scanned text. */
  index: number;
  closing: boolean;
  name: string;
  /** Offset just after the tag's `>`. */
  end: number;
}

/**
 * Restricted tag scan of one line: a comment, a quoted attribute value or an incomplete `<…>` never produces a
 * tag, and only a complete `<name …>` / `</name …>` counts. `inComment` carries a comment across lines, so the
 * container and details scans agree on what a tag is.
 */
function* lineTagSteps(
  text: string, from: number, inComment: boolean, budget: ScanBudget,
): Generator<void, LineTags> {
  const tags: HtmlTagToken[] = [];
  let index = from;
  while (index < text.length) {
    if (inComment) {
      const end = text.indexOf('-->', index);
      if (end < 0) return { tags, inComment: true };
      inComment = false;
      index = end + 3;
      continue;
    }
    const open = text.indexOf('<', index);
    if (open < 0) break;
    if (text.startsWith('<!--', open)) { inComment = true; index = open + 4; continue; }
    const head = /^<(\/?)([a-z][a-z0-9-]*)(?=[\s/>])/i.exec(text.slice(open));
    if (!head) { index = open + 1; continue; }
    const end = tagEnd(text, open);
    // An unterminated tag cannot be a boundary; the rest of this line stays uninterpreted.
    if (end < 0) break;
    if (!charge(budget, 0, end - open)) return { tags, inComment };
    tags.push({ index: open, closing: head[1] === '/', name: head[2].toLocaleLowerCase(), end });
    index = end;
  }
  return { tags, inComment };
}

/**
 * First offset after the closing tag of container `tag` that opens at `at` (its `>` ends at `after`), bounded by
 * the widget source limit; the end of the source when the tag is never closed.
 */
function* containerEndSteps(
  source: LineSource & { length: number }, tag: string, at: number, after: number, budget: ScanBudget,
): Generator<void, number> {
  const first = source.lineAt(at);
  let depth = 1;
  let scanned = 0;
  let inComment = false;
  for (let line = first; line <= source.lines && depth > 0; line++) {
    yield;
    const current = source.text(line);
    scanned += current.length;
    if (scanned > MAX_WIDGET_SOURCE || !charge(budget, 0, 1)) break;
    const scannedLine: LineTags = yield* lineTagSteps(current, line === first ? after - source.start(line) : 0, inComment, budget);
    inComment = scannedLine.inComment;
    for (const token of scannedLine.tags) {
      if (token.name !== tag) continue;
      depth += token.closing ? -1 : 1;
      if (depth === 0) return source.start(line) + token.end;
    }
  }
  return source.length;
}

/**
 * Raw HTML coverage of a Markdown source. A block that opens a container element keeps blocking the lines that
 * follow it until the matching closing tag, even when the Markdown parser ended the block at a blank line.
 */
function* htmlCoverageSteps(
  source: LineSource & { length: number }, blocks: OffsetRange[], budget: ScanBudget,
): Generator<void, HtmlScan> {
  const scan: HtmlScan = { html: [], containers: [], starts: new Set<number>() };
  for (const block of blocks) {
    yield;
    scan.html.push({ from: block.from, to: block.to });
    scan.starts.add(source.lineAt(block.from));
    const open = openTag.exec(source.slice(block.from, Math.min(block.to, block.from + 32)));
    if (!open) continue;
    const tag = open[1].toLocaleLowerCase();
    if (!containerTags.has(tag)) continue;
    const end = yield* containerEndSteps(source, tag, block.from, openTagAfter(source, block.from, block.from + open[0].length), budget);
    scan.containers.push({ from: block.from, to: Math.max(block.to, end) });
    scan.html.push({ from: block.from, to: Math.max(block.to, end) });
  }
  scan.html = mergeRanges(scan.html);
  scan.containers = mergeRanges(scan.containers);
  return scan;
}

const openDetails = /^<details(\s[^>]*)?>$/i;

// `open` must be the attribute name itself: `<details title=" open ">` is closed on load.
function hasOpenAttribute(tag: string): boolean {
  const attributes = tag.replace(/^<details/i, '').replace(/>$/, '').replace(/"[^"]*"|'[^']*'/g, '""');
  return /(^|\s)open(\s|=|$)/i.test(attributes);
}

/** Offset just after the `>` of the tag that starts at `at`, honouring quoted attribute values. */
function tagEnd(line: string, at: number): number {
  let quote = '';
  for (let index = at + 1; index < line.length; index++) {
    const char = line[index];
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '>') return index + 1;
  }
  return -1;
}

/**
 * Offset just after the `>` of the tag that starts at `at`. The opening tag is skipped as a whole, otherwise a
 * quoted attribute value that spells a closing tag would end its container.
 */
function openTagAfter(source: LineSource, at: number, fallback: number): number {
  const line = source.lineAt(at);
  const end = tagEnd(source.text(line), at - source.start(line));
  return end < 0 ? fallback : source.start(line) + end;
}

/**
 * Only a standalone `<details>` block is enhanced. Code fences, comments, raw HTML containers and pseudo tags
 * are not interpreted; if the pairing is not unambiguous the whole candidate stays source instead of swallowing
 * the rest of the note. Nested blocks are rebuilt by the widget.
 */
export function* scanDetailsSteps(
  source: LineSource, context: ScanContext, first = 1, last = source.lines,
): Generator<void, DetailsScan> {
  const ranges: DetailsRange[] = [];
  const unclosed: OffsetRange[] = [];
  for (let line = first; line <= last; line++) {
    yield;
    const text = source.text(line);
    if (context.code(line) || context.container(line) || text !== text.trimStart()) continue;
    if (!openDetails.test(text) || (context.html(line) && !context.htmlStart(line))) continue;
    const opening = tagEnd(text, 0);
    if (opening < 0) continue;
    let depth = 1;
    let scanned = 0;
    let inComment = false;
    let closeStart = -1;
    let closeEnd = -1;
    let closeLine = -1;
    for (let cursor = line; cursor <= source.lines && closeEnd < 0; cursor++) {
      yield;
      const current = source.text(cursor);
      scanned += current.length;
      if (scanned > MAX_WIDGET_SOURCE || !charge(context.budget, 0, current.length)) break;
      if (context.code(cursor) || context.container(cursor)) continue;
      const scannedLine: LineTags = yield* lineTagSteps(current, cursor === line ? opening : 0, inComment, context.budget);
      inComment = scannedLine.inComment;
      for (const token of scannedLine.tags) {
        if (token.name !== 'details') continue;
        if (!token.closing) { depth++; continue; }
        depth--;
        if (depth === 0) {
          closeStart = source.start(cursor) + token.index;
          closeEnd = closeStart + (token.end - token.index);
          closeLine = cursor;
          break;
        }
      }
    }
    // An opener without a closing tag is not a block, but it still owns the note below it: an edit further
    // down might add its closing tag, so the plan has to remember it.
    if (closeEnd < 0 || closeLine < 0) {
      const lastLine = source.lines;
      unclosed.push({ from: source.start(line), to: source.start(lastLine) + source.text(lastLine).length });
      continue;
    }
    // The closing tag must end its line, otherwise the candidate is not a standalone block.
    const closeText = source.text(closeLine).slice(closeStart - source.start(closeLine));
    const closeTag = /^<\/details\s*>/i.exec(closeText)?.[0] ?? '';
    if (!closeTag || closeText.slice(closeTag.length).trim()) continue;
    const start = source.start(line);
    const end = source.start(closeLine) + source.text(closeLine).length;
    if (end - start > MAX_WIDGET_SOURCE) { line = closeLine; continue; }
    const openTag = text.slice(0, opening);
    const inner = source.slice(start + opening, closeStart);
    // Only a summary that opens the body is that block's header. Anything else stays literal body text, which
    // also keeps the body one contiguous slice of the source: a task inside it names its own absolute offset.
    const summaryMatch = /^(\s*)<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i.exec(inner);
    const summary = (summaryMatch?.[2] ?? '').replace(/<[^>]*>/g, '').trim();
    const bodyFrom = start + opening + (summaryMatch?.[0].length ?? 0);
    const body = source.slice(bodyFrom, closeStart);
    ranges.push({ from: start, to: end, open: hasOpenAttribute(openTag), summary, body, bodyFrom });
    line = closeLine;
  }
  return { ranges, unclosed };
}

/**
 * Strips blockquote and list container prefixes so a block formula written inside a container can be recognised.
 * The raw↔logical mapping is kept by the caller.
 */
function containerPrefix(text: string): number {
  let index = 0;
  for (;;) {
    const quote = /^[ \t]*>[ \t]?/.exec(text.slice(index));
    if (quote) { index += quote[0].length; continue; }
    const marker = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(text.slice(index));
    if (marker) { index += marker[0].length; continue; }
    return index;
  }
}

/**
 * Removes the container prefix of a formula's own opening line from one of its lines, and nothing more: a line
 * of TeX that happens to start with `- ` keeps its minus, while a continuation line without a marker of its own
 * loses the indentation that stands in for the parent's prefix.
 */
function stripContainerWidth(text: string, width: number): string {
  if (width <= 0) return text;
  const own = containerPrefix(text);
  const indent = /^[ \t]*/.exec(text)![0].length;
  return text.slice(own > 0 ? Math.min(width, own) : Math.min(width, indent));
}

/** TeX of a candidate formula, read from the source lines with only that candidate's own container removed. */
function blockMathTex(source: LineSource, first: number, last: number): string | null {
  const width = containerPrefix(source.text(first));
  let raw = '';
  for (let line = first; line <= last; line++) raw += (line > first ? '\n' : '') + stripContainerWidth(source.text(line), width);
  const trimmed = raw.trimStart();
  const start = raw.length - trimmed.length + 2;
  const body = raw.replace(/\s+$/, '');
  const end = body.length - 2;
  if (end < start || !body.endsWith('$$')) return null;
  const tex = raw.slice(start, end).trim();
  return !tex || tex.length > MAX_FORMULA_LENGTH ? null : tex;
}

export function* scanBlockMathSteps(
  source: LineSource, context: ScanContext, first = 1, last = source.lines,
): Generator<void, { ranges: MathRange[]; truncated: number }> {
  const ranges: MathRange[] = [];
  const entries: { raw: number; logical: number; length: number }[] = [];
  let logical = '';
  for (let line = first; line <= last; line++) {
    yield;
    const text = source.text(line);
    if (!charge(context.budget, 0, 1)) return { ranges, truncated: 0 };
    const content = text.slice(containerPrefix(text));
    entries.push({ raw: source.start(line), logical: logical.length, length: content.length });
    logical += content;
    if (line < last) logical += '\n';
  }
  const logicalLine = (position: number) => {
    let low = 0;
    let high = entries.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (entries[middle].logical <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  let truncated = 0;
  for (let index = 0; index < entries.length; index++) {
    yield;
    const number = index + first;
    if (context.code(number) || context.html(number)) continue;
    const entry = entries[index];
    const content = logical.slice(entry.logical, entry.logical + entry.length);
    const trimmed = content.trimStart();
    if (!trimmed.startsWith('$$')) continue;
    const start = entry.logical + content.length - trimmed.length + 2;
    // The shared rule keeps escaped delimiters and delimiters inside braces from closing the formula.
    const allowance = { remaining: MAX_FORMULA_LENGTH + 2 };
    const limit = Math.min(logical.length, start + MAX_FORMULA_LENGTH + 2);
    const end = mathEnd(logical, start, limit, '$$', allowance);
    if (!charge(context.budget, 0, MAX_FORMULA_LENGTH + 2 - Math.max(0, allowance.remaining))) return { ranges, truncated };
    if (end < 0) {
      // A window that stops before the formula closes has to grow; only the end of the source rules it out.
      if (last < source.lines && limit === logical.length) {
        truncated = Math.max(truncated, source.start(last) + source.text(last).length +
          (start + MAX_FORMULA_LENGTH + 2 - logical.length));
      }
      continue;
    }
    const closing = logicalLine(end);
    // The closing delimiter must end its own logical line: text after it on the same line is not a block formula.
    if (logical.slice(end + 2, entries[closing].logical + entries[closing].length).trim()) continue;
    // The candidate's own container is removed from its lines; the logical buffer only located the delimiters.
    const tex = blockMathTex(source, number, closing + first);
    if (!tex) continue;
    let blocked = false;
    for (let cursor = index; cursor <= closing; cursor++) {
      if (context.code(cursor + first) || context.html(cursor + first)) { blocked = true; break; }
    }
    if (blocked) { index = closing; continue; }
    ranges.push({ from: entries[index].raw, to: entries[closing].raw + source.text(closing + first).length, tex });
    index = closing;
  }
  return { ranges, truncated };
}

// The Markdown parser the widget bodies use; the same configuration as the live editor's language.
export const snippetParser = markdownParser.configure([Table, TaskList, Strikethrough]);

interface SnippetScan {
  context: ScanContext;
  containers: OffsetRange[];
}

/** Parses a Markdown snippet and scans its raw HTML exactly as the note plan does. */
function snippetScan(source: string, tree = snippetParser.parse(source).topNode): SnippetScan {
  const lines = textLines(source);
  const code = new Set<number>();
  const blocks: OffsetRange[] = [];
  const visit = (node: SyntaxNode) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'FencedCode' || child.name === 'CodeBlock') {
        const last = lines.lineAt(Math.max(child.from, child.to - 1));
        for (let line = lines.lineAt(child.from); line <= last; line++) code.add(line);
        continue;
      }
      if (child.name === 'HTMLBlock' || child.name === 'CommentBlock' || child.name === 'ProcessingInstructionBlock') {
        blocks.push({ from: child.from, to: child.to });
        continue;
      }
      if (child.firstChild) visit(child);
    }
  };
  visit(tree);
  const budget = createScanBudget();
  const iterator = htmlCoverageSteps({ ...lines, length: source.length }, blocks, budget);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return { context: scanContext(lines, code, step.value, budget), containers: step.value.containers };
}

/**
 * The same restricted scanning context as the note itself, computed for a Markdown snippet such as a details
 * body: fences, indented code and raw HTML containers stay literal there too.
 */
export function snippetScanContext(source: string): ScanContext {
  return snippetScan(source).context;
}

/**
 * Raw HTML containers of a Markdown snippet, relative to the snippet. Their content is literal source in the
 * note plan; the widget DOM keeps it literal too, so a recognised container inside a details body is not
 * decorated as Markdown. `tree` lets the caller reuse a parse it already made.
 */
export function snippetContainers(source: string, tree = snippetParser.parse(source).topNode): OffsetRange[] {
  return snippetScan(source, tree).containers;
}

function protectedRanges(doc: Text, tree: ReturnType<typeof syntaxTree>, from: number, to: number, budget: ScanBudget): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (!spendNode(budget)) return false;
      if (['InlineCode', 'CodeText', 'HTMLTag', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock', 'URL'].includes(node.name)) {
        ranges.push({ from: node.from, to: node.to });
      }
      return true;
    },
  });
  return ranges;
}

const insideProtected = (ranges: { from: number; to: number }[], position: number) =>
  ranges.some((range) => position >= range.from && position < range.to);

const wikiLink = /\[\[([0-9a-f-]{36})\|([^\]\r\n]{1,256})\]\]/gi;

function inlineSpans(
  doc: Text, tree: ReturnType<typeof syntaxTree>, from: number, to: number, budget: ScanBudget,
  html: (position: number) => boolean = () => false,
): LiveInlineSpan[] {
  const source = doc.sliceString(from, to);
  if (!source.includes('$') && !source.includes('[[')) return [];
  const protected_ = protectedRanges(doc, tree, from, to, budget);
  const spans: LiveInlineSpan[] = [];
  const mathRanges: { from: number; to: number }[] = [];
  for (let index = 0; index < source.length; index++) {
    if (budget.failure) return spans;
    if (source[index] === '\\') { index++; continue; }
    if (source[index] !== '$') continue;
    if (insideProtected(protected_, from + index) || html(from + index)) continue;
    const delimiter = source.startsWith('$$', index) ? '$$' : '$';
    const start = index + delimiter.length;
    if (delimiter === '$' && /\s/.test(source[start] ?? ' ')) continue;
    const limit = Math.min(source.length, start + MAX_FORMULA_LENGTH + delimiter.length);
    const allowance = { remaining: limit - start };
    const end = mathEnd(source, start, limit, delimiter, allowance);
    // Every candidate spends from the same remaining budget instead of getting a private one.
    if (!charge(budget, 0, limit - start - Math.max(0, allowance.remaining))) return spans;
    if (end < 0 || !mathContentValid(source, start, end, delimiter)) continue;
    // A replacement that covers a line break may not come from a view plugin (CodeMirror throws), so such a
    // candidate keeps its source; standalone block formulas are described by the block scanner instead.
    if (source.slice(index, end + delimiter.length).includes('\n')) continue;
    spans.push({ kind: 'math', from: from + index, to: from + end + delimiter.length, tex: source.slice(start, end), display: delimiter === '$$' });
    mathRanges.push({ from: index, to: end + delimiter.length });
    index = end + delimiter.length - 1;
  }
  wikiLink.lastIndex = 0;
  let match = wikiLink.exec(source);
  while (match) {
    if (!charge(budget, 0, match[0].length)) return spans;
    const localFrom = match.index;
    const localTo = localFrom + match[0].length;
    if (!insideProtected(protected_, from + localFrom) && !html(from + localFrom) &&
        !mathRanges.some((range) => localFrom < range.to && localTo > range.from) &&
        idPattern.test(match[1])) {
      spans.push({ kind: 'wikilink', from: from + localFrom, to: from + localTo, noteId: match[1], label: match[2] });
    }
    match = wikiLink.exec(source);
  }
  return spans.sort((a, b) => a.from - b.from);
}

export interface SliceSource {
  sliceString(from: number, to: number): string;
}

/**
 * Body of a `FencedCode`/`CodeBlock`. A fence or an indented block that continues across container lines is split
 * into one `CodeText` per line with that container's own `QuoteMark`s between them, so its text is every
 * `CodeText` in order: reading the first child alone drops the rest of the code.
 */
export function codeBody(node: SyntaxNode, source: SliceSource): { from: number; to: number; text: string } | null {
  let from = -1;
  let to = -1;
  let text = '';
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'CodeText') continue;
    if (from < 0) from = child.from;
    to = child.to;
    text += source.sliceString(child.from, child.to);
  }
  return from < 0 ? null : { from, to, text };
}

/**
 * Offsets of the label of a `Link` or an `Image`: after its `[`/`![` opener and before the `]` that closes it.
 * The parser's own `LinkMark`s give both edges, so a `]` inside the target (which it accepts) never moves them.
 */
export function labelRange(node: SyntaxNode): OffsetRange {
  let from = node.from;
  let to = node.to;
  let opened = false;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'LinkMark') continue;
    if (!opened) { from = child.to; opened = true; continue; }
    to = child.from;
    break;
  }
  return { from, to: Math.max(from, to) };
}

/** A task marker inside a list item's own source, in that source's offsets. */
export interface ShorthandTask {
  /** Offset of the `[` that opens the marker. */
  from: number;
  /** Offset just past the `]` that closes it. */
  to: number;
  checked: boolean;
}

// `- []` is not a TaskList task (lezer needs the three-character form), but reading already shows it as a
// checkbox. The marker either opens the item, or opens its first line when the item's own line stays empty.
const shorthandTask = /^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+[ \t>]*)*(\n[ \t>]*)?\[([ xX]?)\](?=\s|$)/;

/**
 * The one source rule for a shorthand task inside a list item. `source` is the item's own text up to the end of
 * its first content block, which is exactly what the note plan hands over as a list block's text.
 */
export function shorthandTaskRange(source: string): ShorthandTask | null {
  const match = shorthandTask.exec(source);
  if (!match) return null;
  const marker = { from: match[0].length - 2 - (match[2] ? 1 : 0), to: match[0].length };
  return { ...marker, checked: match[2].toLocaleLowerCase() === 'x' };
}

export function tableData(doc: SliceSource, node: SyntaxNode): LiveTableData {
  const align: ('left' | 'center' | 'right' | null)[] = [];
  const head: string[] = [];
  const rows: string[][] = [];
  const cells = (row: SyntaxNode) => {
    const values: string[] = [];
    for (let child = row.firstChild; child; child = child.nextSibling) {
      if (child.name === 'TableCell') values.push(doc.sliceString(child.from, child.to).trim());
    }
    return values;
  };
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader') head.push(...cells(child));
    else if (child.name === 'TableRow') rows.push(cells(child));
    else if (child.name === 'TableDelimiter') {
      const raw = doc.sliceString(child.from, child.to).trim();
      for (const part of raw.replace(/^\|/, '').replace(/\|$/, '').split('|')) {
        const value = part.trim();
        const left = value.startsWith(':');
        const right = value.endsWith(':');
        align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
      }
    }
  }
  return { align, head, rows };
}

/** A half-open offset range snapped to whole lines. */
interface Region {
  from: number;
  to: number;
}

/** End of the last line whose container-stripped text starts with `$$`, or -1 when the note has none. */
function* lastBlockMathSteps(source: LineSource, budget: ScanBudget): Generator<void, number> {
  for (let line = source.lines; line >= 1; line--) {
    if (!charge(budget, 0, 1)) return -1;
    const text = source.text(line);
    yield;
    if (text.slice(containerPrefix(text)).startsWith('$$')) return source.start(line) + text.length;
  }
  return -1;
}

/**
 * Where the block formula structure above `position` stops being ambiguous. Formulas pair in order, so the only
 * unambiguous starts are the end of a formula the previous plan closed and the start of the note.
 */
function* mathSafeStartSteps(
  source: LineSource, position: number, closed: readonly number[], budget: ScanBudget,
): Generator<void, number> {
  let scanned = 0;
  for (let line = source.lineAt(position) - 1; line >= 1 && scanned <= MAX_FORMULA_LENGTH + 2; line--) {
    if (!charge(budget, 0, 1)) return 0;
    const text = source.text(line);
    scanned += text.length + 1;
    yield;
    if (!text.slice(containerPrefix(text)).startsWith('$$')) continue;
    const end = source.start(line) + text.length;
    if (closed.includes(end)) return end;
  }
  return 0;
}

export interface LivePlanSeed {
  /** The previous plan, already mapped onto the current document and without the blocks this change touched. */
  plan: LiveMarkdownPlan;
  /** Every range the change touched, including the full extent of each block it removed from the plan. */
  dirty: readonly OffsetRange[];
  /** The ranges are only work a previous plan still owes; they are described in bounded chunks. */
  owed?: boolean;
}

/** Container nodes whose subtree is small enough to be described again as one unit. */
const containerNodes = new Set(['Blockquote', 'BulletList', 'OrderedList', 'ListItem']);

/**
 * Widens the dirty ranges of one document change into the region the next plan has to describe again. Both
 * boundaries end outside anything the change can reach: the innermost Markdown container that holds it, the
 * top-level nodes it touches, raw HTML containers that are still open, and whole lines.
 */
function* regionSteps(
  state: EditorState, tree: ReturnType<typeof syntaxTree>, lines: LineSource & { length: number },
  dirty: readonly OffsetRange[], previous: LiveMarkdownPlan, budget: ScanBudget,
): Generator<void, Region> {
  const doc = state.doc;
  let from = dirty[0].from;
  let to = dirty[0].to;
  for (const range of dirty) { from = Math.min(from, range.from); to = Math.max(to, range.to); }
  from = doc.lineAt(Math.max(0, Math.min(from, doc.length))).from;
  to = doc.lineAt(Math.max(0, Math.min(to, doc.length))).to;
  // Block ranges end at a line end, so a change next to a line edge also concerns the neighbouring line.
  if (from > 0) from = doc.lineAt(from - 1).from;
  if (to < doc.length) to = doc.lineAt(to + 1).to;
  for (let round = 0; round < 6; round++) {
    yield;
    let nextFrom = from;
    let nextTo = to;
    // A region never cuts a described block in half: the whole block is either reused or described again.
    for (const block of previous.blocks) {
      if (block.from >= nextTo || block.to <= nextFrom) continue;
      nextFrom = Math.min(nextFrom, block.from);
      nextTo = Math.max(nextTo, block.to);
    }
    // A list or a quote can absorb or release the blocks next to it, so the region grows over that run too:
    // `listDepth` and `quoteDepth` only mean something relative to the containers around a block.
    const container = (block: LiveBlock) => block.listDepth > 0 || block.quoteDepth > 0;
    for (let index = previous.blocks.length - 1; index >= 0; index--) {
      const block = previous.blocks[index];
      if (block.from >= nextFrom) continue;
      if (!container(block)) break;
      nextFrom = Math.min(nextFrom, block.from);
    }
    for (const block of previous.blocks) {
      if (block.to <= nextTo) continue;
      if (!container(block)) break;
      nextTo = Math.max(nextTo, block.to);
    }
    // Raw HTML absorbs everything it covers, so a change inside it describes the whole container again.
    for (const range of previous.html) {
      if (range.from >= nextTo || range.to <= nextFrom) continue;
      nextFrom = Math.min(nextFrom, range.from);
      nextTo = Math.max(nextTo, range.to);
    }
    const top: SyntaxNode[] = [];
    for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
      if (child.to < from || child.from > to) continue;
      top.push(child);
    }
    // A change inside one block unit (list item, quote) re-describes that unit; one spanning two widens to both.
    if (top.length === 1 && top[0].from <= from && top[0].to >= to) {
      let node = top[0];
      for (;;) {
        let inner: SyntaxNode | null = null;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.from <= from && child.to >= to && containerNodes.has(child.name)) { inner = child; break; }
        }
        if (!inner) break;
        node = inner;
      }
      nextFrom = Math.min(nextFrom, node.from);
      nextTo = Math.max(nextTo, node.to);
    } else {
      for (const node of top) { nextFrom = Math.min(nextFrom, node.from); nextTo = Math.max(nextTo, node.to); }
    }
    // Raw HTML containers that open before the region still block interpretation after a blank line.
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
      if (node.to > from) break;
      if (node.name !== 'HTMLBlock' && node.name !== 'CommentBlock' && node.name !== 'ProcessingInstructionBlock') continue;
      const open = openTag.exec(doc.sliceString(node.from, Math.min(node.to, node.from + 32)));
      if (!open) continue;
      const tag = open[1].toLocaleLowerCase();
      if (!containerTags.has(tag)) continue;
      const end = yield* containerEndSteps(lines, tag, node.from, openTagAfter(lines, node.from, node.from + open[0].length), budget);
      if (end <= nextFrom) continue;
      nextFrom = Math.min(nextFrom, node.from);
      nextTo = Math.max(nextTo, end);
    }
    nextFrom = doc.lineAt(nextFrom).from;
    nextTo = doc.lineAt(Math.min(nextTo, doc.length)).to;
    if (nextFrom === from && nextTo === to) return { from, to };
    from = nextFrom;
    to = nextTo;
  }
  return { from, to };
}

interface RegionAnalysis {
  blocks: LiveBlock[];
  /** Raw HTML coverage of the region, merged and complete for every line inside it. */
  coverage: OffsetRange[];
  math: OffsetRange[];
  details: OffsetRange[];
  openDetails: OffsetRange[];
  missing: OffsetRange[];
  /** Set when a structural block reaches past the region, so the region has to grow and be described again. */
  extend: number;
  /** Start of the structure above the region that a closing tag or delimiter inside it belongs to, or -1. */
  reopen: number;
  /** End of the work this analysis described; a block that reaches past the region counts as a whole. */
  describedTo: number;
}

/**
 * Builds the renderable block list from the live syntax tree plus the two syntaxes lezer does not know:
 * standalone `<details>` blocks and `$…$` math. It never touches the document or the DOM. A region limits the
 * walk and both extra syntax scans to the part of the note a change can reach; `null` describes everything.
 *
 * The body is a generator so the caller can spread the work over frames; every loop consults one shared
 * budget for nodes, scanned characters and the plan deadline.
 */
function* regionAnalysisSteps(
  state: EditorState, tree: ReturnType<typeof syntaxTree>, lines: LineSource, budget: ScanBudget,
  region: Region | null, previous: LiveMarkdownPlan | null, owesWork = false,
): Generator<void, RegionAnalysis> {
  const doc = state.doc;
  const firstLine = region ? doc.lineAt(region.from).number : 1;
  const lastLine = region ? doc.lineAt(Math.max(region.from, Math.min(region.to, doc.length) - 1)).number : doc.lines;
  /** A child outside the region keeps its mapping in place: it is reused instead of described again. */
  const withinRegion = (node: SyntaxNode) => !region || (node.to > region.from && node.from < region.to);
  const codeLines = new Set<number>();
  /** Raw HTML blocks; a block that opens a container covers everything up to its closing tag. */
  const htmlBlocks: OffsetRange[] = [];
  // A parsed block can end exactly at the start of the next line; that line is not part of it.
  const markLines = (set: Set<number>, from: number, to: number) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(Math.max(from, Math.min(to, doc.length) - 1)).number;
    for (let line = first; line <= last; line++) set.add(line);
    return first;
  };
  const markHtml = (from: number, to: number) => { htmlBlocks.push({ from, to }); };
  let blocks: LiveBlock[] = [];
  /** Inline spans need the raw HTML coverage, which is only known after the tree walk. */
  const pendingInline: { block: LiveBlock; from: number; to: number }[] = [];

  /**
   * Ranges the plan still owes: the parse had not reached them, or this plan deliberately described only the
   * first chunk of owed work. A plan without owed ranges claims the whole note is described.
   */
  const missing: OffsetRange[] = [];
  const push = (block: Omit<LiveBlock, 'line' | 'endLine' | 'text'>): LiveBlock | null => {
    if (budget.failure) return null;
    if (++budget.blocks > MAX_BLOCKS || (block.block && ++budget.widgets > MAX_WIDGETS)) {
      budget.failure = 'budget';
      return null;
    }
    if (!Number.isInteger(block.from) || !Number.isInteger(block.to)) return null;
    if (!(block.from >= 0 && block.from < block.to && block.to <= doc.length)) return null;
    // Only ranges the parser really finished are rendered; the rest of the note stays editable source.
    if (!syntaxTreeAvailable(state, block.to)) {
      missing.push({ from: block.from, to: block.to });
      return null;
    }
    const startLine = doc.lineAt(block.from).number;
    const endLine = doc.lineAt(block.to).number;
    const created: LiveBlock = { ...block, line: startLine - 1, endLine: endLine - 1, text: doc.sliceString(block.from, block.to) };
    blocks.push(created);
    return created;
  };

  const lineStart = (position: number) => doc.lineAt(Math.min(position, doc.length)).from;
  const lineEnd = (position: number) => doc.lineAt(Math.min(position, doc.length)).to;

  const textBlock = (kind: LiveBlockKind, from: number, to: number, extra: Partial<LiveBlock> = {}, inline = true) => {
    const block = push({
      kind, from: lineStart(from), to: lineEnd(to), headingLevel: 0, listDepth: 0, quoteDepth: 0, block: false,
      inline: [], ...extra,
    });
    if (block && inline) pendingInline.push({ block, from, to });
  };

  const widgetBlock = (kind: LiveBlockKind, from: number, to: number, extra: Partial<LiveBlock> = {}) => {
    if (to - from > MAX_WIDGET_SOURCE) return;
    push({
      kind, from: lineStart(from), to: lineEnd(to), headingLevel: 0, listDepth: 0, quoteDepth: 0, block: true,
      inline: [], ...extra,
    });
  };

  const collectItem = function* (item: SyntaxNode, depth: number, listDepth: number, quoteDepth: number): Generator<void> {
    let seenContent = false;
    for (let child = item.firstChild; child; child = child.nextSibling) {
      if (!spendNode(budget)) return;
      if (child.name === 'ListMark' || child.name === 'QuoteMark') continue;
      if (!withinRegion(child)) {
        // Content before the region was this item's content in the previous plan; later siblings stay source-free.
        if (child.to <= region!.from) seenContent = true;
        continue;
      }
      if (child.name === 'BulletList' || child.name === 'OrderedList') {
        for (let nested = child.firstChild; nested; nested = nested.nextSibling) {
          if (nested.name !== 'ListItem' || !withinRegion(nested)) continue;
          yield;
          yield* collectItem(nested, depth + 1, listDepth + 1, quoteDepth);
        }
        continue;
      }
      if (!seenContent) {
        seenContent = true;
        if (child.name === 'Task') {
          textBlock('task', item.from, child.to, { listDepth, quoteDepth });
          continue;
        }
        if (child.name === 'FencedCode' || child.name === 'CodeBlock' || child.name === 'Table') {
          const info = child.getChild('CodeInfo');
          const body = codeBody(child, doc);
          const language = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0].toLocaleLowerCase() : '';
          const codeText = body ? body.text : '';
          if (child.name === 'Table') {
            widgetBlock('table', item.from, child.to, { table: tableData(doc, child), listDepth, quoteDepth });
          } else {
            markLines(codeLines, child.from, child.to);
            if (!language || language === 'mermaid') {
              textBlock('code', item.from, child.to, { language, listDepth, quoteDepth, source: true }, false);
            } else {
              widgetBlock('code', item.from, child.to, { language, codeText, listDepth, quoteDepth });
            }
          }
          continue;
        }
        textBlock('list', item.from, child.to, { listDepth, quoteDepth });
        continue;
      }
      yield* collect(child, depth + 1, listDepth, quoteDepth);
    }
  };

  const collect = function* (node: SyntaxNode, depth: number, listDepth: number, quoteDepth: number): Generator<void> {
    if (!spendNode(budget) || depth > MAX_DEPTH) return;
    switch (node.name) {
      case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3': case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6':
      case 'SetextHeading1': case 'SetextHeading2':
        textBlock('heading', node.from, node.to, { headingLevel: Number(node.name.at(-1)), listDepth, quoteDepth });
        return;
      case 'FencedCode': {
        const info = node.getChild('CodeInfo');
        const body = codeBody(node, doc);
        const language = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0].toLocaleLowerCase() : '';
        markLines(codeLines, node.from, node.to);
        if (!language || language === 'mermaid') {
          textBlock('code', node.from, node.to, { language, listDepth, quoteDepth, source: true }, false);
          return;
        }
        widgetBlock('code', node.from, node.to, {
          language, codeText: body ? body.text : '', listDepth, quoteDepth,
        });
        return;
      }
      case 'CodeBlock': {
        const body = codeBody(node, doc);
        markLines(codeLines, node.from, node.to);
        widgetBlock('code', body?.from ?? node.from, body?.to ?? node.to, {
          language: '', codeText: body ? body.text : '', listDepth, quoteDepth,
        });
        return;
      }
      case 'Table':
        widgetBlock('table', node.from, node.to, { table: tableData(doc, node), listDepth, quoteDepth });
        return;
      case 'HorizontalRule':
        widgetBlock('rule', node.from, node.to, { listDepth, quoteDepth });
        return;
      case 'Paragraph': {
        const first = node.firstChild;
        if (first?.name === 'Image' && !first.nextSibling) {
          widgetBlock('image', node.from, node.to, { listDepth, quoteDepth });
          return;
        }
        textBlock('paragraph', node.from, node.to, { listDepth, quoteDepth });
        return;
      }
      case 'Blockquote':
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name === 'QuoteMark' || !withinRegion(child)) continue;
          yield;
          yield* collect(child, depth + 1, listDepth, quoteDepth + 1);
        }
        return;
      case 'BulletList':
      case 'OrderedList':
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== 'ListItem' || !withinRegion(child)) continue;
          yield;
          yield* collectItem(child, depth + 1, listDepth + 1, quoteDepth);
        }
        return;
      case 'HTMLBlock': {
        // Raw HTML is never interpreted; a block that opens a container element also blocks the lines that
        // follow it until its closing tag.
        markHtml(node.from, node.to);
        return;
      }
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
        markHtml(node.from, node.to);
        return;
      case 'LinkReference':
        return;
      default:
        textBlock('paragraph', node.from, node.to, { listDepth, quoteDepth });
    }
  };

  for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
    if (budget.failure) break;
    if (region && child.to <= region.from) continue;
    if (region && child.from >= region.to) break;
    yield;
    yield* collect(child, 0, 0, 0);
  }
  yield;

  const scan = yield* htmlCoverageSteps({ ...lines, length: doc.length }, htmlBlocks, budget);
  const context = scanContext(lines, codeLines, scan, budget);
  // A block that reaches past the region was described as a whole (the tree walk always closes it), so the work
  // this plan really covered ends at that block's end. A boundary left inside it would describe the same block
  // again on the next chunk and the owed range would never shrink.
  const regionEnd = region
    ? Math.min(region.to, Math.max(tree.length, region.from))
    : Math.min(tree.length, doc.length);
  const describedTo = region
    ? blocks.reduce((to, block) => block.from < region!.to ? Math.max(to, block.to) : to, regionEnd)
    : regionEnd;
  // A recognised container is literal source, blank lines included, so no ordinary block inside it is described.
  // Standalone details and block math inside it are already excluded by both scanners via `context.container`.
  if (scan.containers.length) blocks = blocks.filter((block) => !insideRanges(scan.containers, block.from));
  // Math and wiki links inside raw HTML keep their literal source, so the inline pass needs the coverage.
  for (const pending of pendingInline) {
    if (budget.failure) break;
    if (insideRanges(scan.containers, pending.block.from)) continue;
    yield;
    pending.block.inline = inlineSpans(doc, tree, pending.from, pending.to, budget, (position) => insideRanges(scan.html, position));
  }
  const details = yield* scanDetailsSteps(lines, context, firstLine, lastLine);
  const math = yield* scanBlockMathSteps(lines, context, firstLine, lastLine);
  let extend = math.truncated;
  // A container that keeps blocking lines below the region has to swallow them in the plan as well.
  for (const range of scan.html) if (region && range.to > region.to) extend = Math.max(extend, range.to);
  let reopen = -1;
  if (region && previous) {
    // A formula or collapsible block the change touched may have lost or gained its own closing delimiter; any
    // tag or delimiter inside the region decides where the pairing above it is still settled.
    const touches = (ranges: readonly OffsetRange[]) =>
      ranges.some((range) => range.from < region!.to && range.to > region!.from);
    let math = touches(previous.math);
    // Any `<` can add or remove a tag, so a region that had a tag before and lost it still counts as changed.
    let detailsChanged = touches(previous.details) || touches(previous.html);
    for (let line = firstLine; line <= lastLine && !(math && detailsChanged); line++) {
      if (context.code(line) || (context.html(line) && !context.htmlStart(line))) continue;
      const lowered = lines.text(line).toLocaleLowerCase();
      if (!detailsChanged && lowered.includes('<')) detailsChanged = true;
      if (!math && lowered.includes('$$')) math = true;
    }
    if (detailsChanged) {
      // A block the previous plan closed settles only itself. An opener that never closed still owns the note
      // below it, so a closing tag added further down has to bring that whole ancestor back into the region.
      const open = previous.openDetails.filter((range) => range.from < region!.from);
      if (open.length) reopen = Math.min(...open.map((range) => range.from));
    }
    if (math) {
      const closed = previous.blocks.filter((block) => block.kind === 'math').map((block) => block.to);
      const start = yield* mathSafeStartSteps(lines, region.from, closed, budget);
      if (start >= 0 && start < region.from) reopen = reopen >= 0 ? Math.min(reopen, start) : start;
      // Formulas pair in order, so a delimiter in the region can change the role of every delimiter below it.
      const last = yield* lastBlockMathSteps(lines, budget);
      if (last > region.to) extend = Math.max(extend, last);
    }
  }
  if (!budget.failure) {
    for (const range of math.ranges) {
      const to = lineEnd(range.to);
      if (region && to > region.to) { extend = Math.max(extend, to); continue; }
      push({
        kind: 'math', from: lineStart(range.from), to, headingLevel: 0, listDepth: 0, quoteDepth: 0,
        block: true, inline: [], mathTex: range.tex,
      });
    }
    for (const range of details.ranges) {
      if (region && range.to > region.to) { extend = Math.max(extend, lineEnd(range.to)); continue; }
      push({
        kind: 'details', from: range.from, to: range.to, headingLevel: 0, listDepth: 0, quoteDepth: 0, block: true,
        inline: [], details: { open: range.open, summary: range.summary, body: range.body, bodyFrom: range.bodyFrom },
      });
    }
    // Anything below the range this plan walked is undescribed, whether the parser stopped early or the owed
    // chunks of the previous plan were only partly finished. `tree.length` is the frontier of the nodes that
    // actually exist; `syntaxTreeAvailable` can already be true for a tree snapshot that does not hold them.
    // A region that re-describes an ordinary edit keeps its remaining owed work from the mapped plan instead.
    if (!region || owesWork) {
      if (describedTo < doc.length) missing.push({ from: describedTo, to: doc.length });
    }
  }
  return {
    blocks, coverage: scan.html, math: math.ranges.map((range) => ({ from: range.from, to: range.to })),
    details: details.ranges.map((range) => ({ from: range.from, to: range.to })),
    openDetails: details.unclosed, missing, extend, reopen, describedTo,
  };
}

/**
 * Plan for the live editor. With a seed, only the region the change can reach is described again and every
 * other block is reused from the mapped previous plan; without one the whole document is described.
 */
export function* analyzeLiveMarkdownSteps(state: EditorState, seed?: LivePlanSeed): Generator<void, LiveMarkdownPlan> {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const lines = docLines(doc);
  const budget = createScanBudget();
  const previous = seed && seed.plan.doc === doc && seed.dirty.length ? seed.plan : null;
  // Owed work begins exactly where the previous plan stopped describing. That boundary already sits at a block
  // or line end, so the region must not creep one line back into the structure that ends there: re-describing a
  // long fence from its last line would pull the chunk back to the fence start on every round.
  const owesWork = !!seed?.owed;
  const owedFrom = owesWork ? Math.min(...seed!.dirty.map((range) => range.from)) : 0;
  const clampOwed = (value: Region): Region =>
    owesWork && value.from < owedFrom ? { from: owedFrom, to: value.to } : value;
  let region = previous
    ? clampOwed(yield* regionSteps(state, tree, { ...lines, length: doc.length }, seed!.dirty, previous, budget))
    : null;
  if (region && owesWork && region.to - region.from > MAX_OWED_CHARS) {
    region = { from: region.from, to: doc.lineAt(Math.min(doc.length, region.from + MAX_OWED_CHARS)).to };
  }
  let analysis = yield* regionAnalysisSteps(state, tree, lines, budget, region, previous, owesWork);
  // A structural block that reaches out of the region widens it; the description is repeated, never patched.
  const grows = () => analysis.extend > 0 || analysis.reopen >= 0;
  for (let round = 0; region && grows() && round < 6; round++) {
    const before = region;
    const wider = [{ from: analysis.reopen >= 0 ? analysis.reopen : region.from, to: Math.max(region.to, analysis.extend) }];
    region = clampOwed(yield* regionSteps(state, tree, { ...lines, length: doc.length }, wider, previous!, budget));
    analysis = yield* regionAnalysisSteps(state, tree, lines, budget, region, previous, owesWork);
    // A region that cannot grow any further would report the same structure again.
    if (region.from === before.from && region.to === before.to) break;
  }
  // A structure that keeps growing is described as a whole instead of keeping neighbours from the old plan.
  if (region && grows()) {
    region = null;
    analysis = yield* regionAnalysisSteps(state, tree, lines, budget, null, null);
  }
  const bounds = region;
  const blocks = previous && bounds
    ? [...previous.blocks.filter((block) => block.to <= bounds.from || block.from >= bounds.to), ...analysis.blocks]
    : analysis.blocks;
  // Structures outside the region still belong to the plan; the region reported its own.
  const outside = (range: OffsetRange) => range.to <= bounds!.from || range.from >= bounds!.to;
  const merge = (ranges: OffsetRange[], included: OffsetRange[]) => previous && bounds
    ? mergeRanges([...ranges.filter(outside), ...included])
    : included;
  const html = merge(previous ? previous.html : [], analysis.coverage);
  const math = merge(previous ? previous.math : [], analysis.math);
  const details = merge(previous ? previous.details : [], analysis.details);
  // An unclosed opener reaches the end of the note, so it always straddles a region below it: it is kept while
  // its own line stays outside the region, and described again when the region reaches it.
  const openDetails = previous && bounds
    ? mergeRanges([
      ...previous.openDetails.filter((range) => range.from < bounds.from || range.from >= bounds.to),
      ...analysis.openDetails,
    ])
    : analysis.openDetails;
  // Owed work stays owed unless this plan described it. A region only absorbs the part of a range it really
  // walked: the nodes it inspected and the blocks it described decide how far that is, and the rest of the range
  // remains outstanding for the next plan. Dropping the remainder here would leave that text as source forever.
  const covered = bounds ? { from: bounds.from, to: analysis.describedTo } : null;
  const missing = mergeRanges(previous && covered
    ? [
      ...previous.missing.flatMap((range) => {
        if (range.to <= covered.from || range.from >= covered.to) return [range];
        return [
          { from: range.from, to: Math.min(range.to, covered.from) },
          { from: Math.max(range.from, covered.to), to: range.to },
        ].filter((part) => part.to > part.from);
      }),
      ...analysis.missing,
    ]
    : analysis.missing);
  // At equal offsets the replacement block sorts first so it owns the range and inner blocks are dropped.
  blocks.sort((a, b) => a.from - b.from || (a.block === b.block ? a.to - b.to : a.block ? -1 : 1));
  // A details or math block owns everything it covers, so no inner block may add an overlapping replacement.
  const result: LiveBlock[] = [];
  let cover: LiveBlock | null = null;
  for (const block of blocks) {
    if (cover && (block.from < cover.from || block.to > cover.to)) cover = null;
    if (cover) continue;
    result.push(block);
    if (block.block && (block.kind === 'details' || block.kind === 'math')) cover = block;
  }
  return {
    doc, docLength: doc.length, blocks: result, html, math, details, openDetails, missing, failure: budget.failure,
  };
}

export function analyzeLiveMarkdown(state: EditorState, seed?: LivePlanSeed): LiveMarkdownPlan {
  const iterator = analyzeLiveMarkdownSteps(state, seed);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}
