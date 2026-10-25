import { WidgetType, type EditorView } from '@codemirror/view';
import DOMPurify from 'dompurify';
import type { SyntaxNode } from '@lezer/common';
import { t } from './i18n';
import { privateFileId, markdownTarget } from './markdownResources';
import { MAX_FORMULA_LENGTH } from './math';
import {
  codeBody, insideRanges, labelRange, scanDetailsSteps, shorthandTaskRange, snippetContainers, snippetParser,
  snippetScanContext, tableData, textLines, type DetailsRange, type LiveTableData, type SliceSource,
} from './livePreviewSyntax';

export interface LiveWidgetHost {
  safeHref(source: string): string | null;
  /** `<https://…>` and `<user@example.com>` targets, resolved the same way in every surface. */
  autolinkHref(source: string): string | null;
  /** Absolute source offset of a task marker; the host resolves its line against the current document. */
  onTask(position: number, checked: boolean): void;
  /** 0-based source line of an absolute offset, or null when it is outside the current document. */
  sourceLine(position: number): number | null;
  onImage(src: string, release?: () => void): void;
  onNote(id: string): void;
  onFile(id: string, href: string): void;
  resolveFile?(id: string): Promise<string | null>;
  /** Drops the block's rendering so the real Markdown source becomes editable again. */
  expose(from: number, to: number): void;
  notify(message: string): void;
  requestMeasure(): void;
  /** Records a fold; `key` identifies a nested block and `identity` the owning block's source. */
  fold(from: number, key: string, identity: string, open: boolean): void;
  /** Current fold state of the same block, so nested state survives a rebuilt widget. */
  folded(from: number, key: string, identity: string, fallback: boolean): boolean;
}

const mathNamespace = 'http://www.w3.org/1998/Math/MathML';

const objectUrls = new WeakMap<HTMLElement, string[]>();
function ownUrl(host: HTMLElement, url: string) {
  const urls = objectUrls.get(host) ?? [];
  urls.push(url);
  objectUrls.set(host, urls);
}
function releaseUrls(host: HTMLElement) {
  for (const url of objectUrls.get(host) ?? []) URL.revokeObjectURL(url);
  objectUrls.delete(host);
}

function stamp(node: HTMLElement, from: number): HTMLElement {
  node.dataset.liveFrom = String(from);
  return node;
}

function element(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const sliceOf = (text: string): SliceSource => ({ sliceString: (from: number, to: number) => text.slice(from, to) });

/**
 * A widget whose own construction throws must not break the editor update: the caller gets a literal shell and
 * the failure is turned into a source reveal on the next task.
 */
function guarded(build: () => HTMLElement, text: string, recover: () => void): HTMLElement {
  try {
    return build();
  } catch {
    window.setTimeout(recover, 0);
    return element('span', 'cm-live-literal', text);
  }
}

/**
 * The one anchor builder of the safe DOM path. Content inside a block widget is not backed by CodeMirror
 * decorations, so a link needs the same `data-live-action` marker the controller looks for; otherwise a mouse
 * press is taken for "edit this whole block" and the click is swallowed. A private file keeps its download
 * action, so it uses the offline-aware `onFile` path instead of opening a new tab.
 */
function linkElement(href: string, fileId?: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.className = 'cm-live-link';
  anchor.href = href;
  if (fileId) {
    anchor.dataset.liveAction = 'file';
    anchor.dataset.fileId = fileId;
    return anchor;
  }
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.dataset.liveAction = 'href';
  return anchor;
}

const textOf = (text: string) => document.createTextNode(text);

/**
 * One inline syntax node as DOM. A link label is built by this same function, so the inline code, emphasis and
 * images inside it keep their structure instead of being pasted as their source text.
 */
function inlineNode(parent: Node, node: SyntaxNode, source: string, host: LiveWidgetHost) {
  switch (node.name) {
    case 'StrongEmphasis': { const strong = element('strong'); appendInline(strong, node, source, host); parent.appendChild(strong); return; }
    case 'Emphasis': { const em = element('em'); appendInline(em, node, source, host); parent.appendChild(em); return; }
    case 'Strikethrough': { const del = element('del'); appendInline(del, node, source, host); parent.appendChild(del); return; }
    case 'InlineCode': {
      // The delimiters are `CodeMark` nodes of their own; their real edges keep a multi-backtick span intact
      // instead of leaving one backtick on each side of the code text.
      let start = -1;
      let end = -1;
      for (let mark = node.firstChild; mark; mark = mark.nextSibling) {
        if (mark.name !== 'CodeMark') continue;
        if (start < 0) start = mark.to;
        else { end = mark.from; break; }
      }
      parent.appendChild(element('code', 'cm-live-inline-code',
        start >= 0 && end > start ? source.slice(start, end) : source.slice(node.from, node.to)));
      return;
    }
    case 'Autolink': {
      // `<https://…>` and `<user@example.com>` keep their whole text; only the angle brackets disappear.
      const text = source.slice(node.from + 1, node.to - 1);
      const href = host.autolinkHref(text);
      if (!href) { parent.appendChild(textOf(text)); return; }
      const anchor = linkElement(href);
      anchor.textContent = text;
      parent.appendChild(anchor);
      return;
    }
    case 'Link': {
      const url = node.getChild('URL');
      const label = labelRange(node);
      if (!url) { parent.appendChild(textOf(source.slice(node.from, node.to))); return; }
      const raw = source.slice(url.from, url.to);
      // `<…>` is Markdown syntax, not part of the target: the link and the file action both use its value.
      const target = markdownTarget(raw);
      // A private file target goes through the same offline download entry as the reading surface, not `_blank`.
      const fileId = privateFileId(raw);
      const href = fileId ? target : host.safeHref(raw);
      if (!href) { parent.appendChild(textOf(source.slice(node.from, node.to))); return; }
      const anchor = linkElement(href, fileId ?? undefined);
      appendInlineRange(anchor, node, label.from, label.to, source, host);
      parent.appendChild(anchor);
      return;
    }
    case 'Image': {
      const label = labelRange(node);
      parent.appendChild(element('span', 'cm-live-inline-image-alt', source.slice(label.from, label.to)));
      return;
    }
    // `HeaderMark` is deliberately not skipped here: only a real heading drops its marks (`headingRange` clips
    // them), while a table cell keeps `##` as the literal text it is.
    case 'EmphasisMark': case 'StrikethroughMark': case 'LinkMark': case 'CodeMark': case 'QuoteMark':
    case 'URL': case 'LinkTitle': break;
    default:
      if (node.firstChild) appendInline(parent, node, source, host);
      else parent.appendChild(textOf(source.slice(node.from, node.to)));
  }
}

function appendInline(parent: Node, node: SyntaxNode, source: string, host: LiveWidgetHost) {
  appendInlineRange(parent, node, node.from, node.to, source, host);
}

/**
 * Builds the inline nodes and the plain text between them from `from` to `to` of `node`. Plain text between two
 * syntax nodes is not a lezer node, so the gap between children must be copied too; clipping both ends is what
 * lets a link label reuse this code without its target or a title.
 */
function appendInlineRange(parent: Node, node: SyntaxNode, from: number, to: number, source: string, host: LiveWidgetHost) {
  let cursor = from;
  const gap = (end: number) => {
    if (end <= cursor) return;
    const text = source.slice(cursor, end);
    if (text) parent.appendChild(textOf(text));
    cursor = end;
  };
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from) continue;
    if (child.from >= to) break;
    gap(child.from);
    inlineNode(parent, child, source, host);
    cursor = Math.max(cursor, child.to);
  }
  gap(to);
}

function buildTable(table: LiveTableData, host: LiveWidgetHost): HTMLTableElement {
  const node = element('table', 'cm-live-widget cm-live-table') as HTMLTableElement;
  const align = (index: number, cell: HTMLTableCellElement) => {
    const value = table.align[index];
    if (value) cell.classList.add(`cm-live-align-${value}`);
  };
  const head = node.createTHead().insertRow();
  table.head.forEach((cell, index) => {
    const th = document.createElement('th');
    th.appendChild(inlineFragment(cell, host));
    align(index, th);
    head.appendChild(th);
  });
  if (table.rows.length) {
    const body = node.createTBody();
    for (const row of table.rows) {
      const tr = body.insertRow();
      row.forEach((cell, index) => {
        const td = tr.insertCell();
        td.appendChild(inlineFragment(cell, host));
        align(index, td);
      });
    }
  }
  return node;
}

function inlineFragment(source: string, host: LiveWidgetHost): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!source) return fragment;
  appendInline(fragment, snippetParser.parse(source).topNode, source, host);
  return fragment;
}

/**
 * The text of a heading inside a snippet: its own `HeaderMark`s are syntax, not content. ATX loses the opening
 * mark and the space after it plus any closing run, a Setext heading loses its underline line together with the
 * quote or list prefix that stands in front of the underline.
 */
function headingRange(node: SyntaxNode, source: string): { from: number; to: number } {
  let from = node.from;
  let to = node.to;
  let marks = 0;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'HeaderMark') continue;
    if (marks === 0) {
      if (node.name.startsWith('ATX') && (source[child.to] === ' ' || source[child.to] === '\t')) from = child.to + 1;
      else if (node.name.startsWith('ATX')) from = child.to;
      else {
        // The underline is the line below the heading text, so the text ends at the line break in front of it.
        const lineBreak = source.lastIndexOf('\n', child.from - 1);
        to = lineBreak >= node.from ? lineBreak : child.from;
      }
    } else if (node.name.startsWith('ATX')) to = child.from;
    marks++;
  }
  while (to > from && /\s/.test(source[to - 1])) to--;
  return { from, to };
}

/** The first `ListMark` number of an ordered list, so a source that starts at `3.` keeps starting at 3. */
function orderedStart(node: SyntaxNode, source: string): number | null {
  for (let item = node.firstChild; item; item = item.nextSibling) {
    if (item.name !== 'ListItem') continue;
    for (let mark = item.firstChild; mark; mark = mark.nextSibling) {
      if (mark.name !== 'ListMark') continue;
      const value = source.slice(mark.from, mark.to).replace(/[.)]$/, '');
      const start = Number(value);
      return /^\d{1,9}$/.test(value) && Number.isInteger(start) ? start : null;
    }
  }
  return null;
}

/** An item's first content child: its `ListMark` and a quoted line's `QuoteMark` are syntax, not content. */
function firstContent(item: SyntaxNode): SyntaxNode | null {
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'ListMark' && child.name !== 'QuoteMark') return child;
  }
  return null;
}

function parseBlocks(source: string, host: LiveWidgetHost, origin = 0): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const tree = snippetParser.parse(source).topNode;
  // A recognised container is literal source in the note plan; the DOM built from a details body keeps the same
  // boundary, so no ordinary Markdown inside it is decorated here either. Every block, including the first
  // paragraph of a list item, passes this check on its way into `emit`.
  const containers = snippetContainers(source, tree);
  // Every block is appended to the parent it belongs to: a nested list goes inside its `li`, not next to the
  // enclosing list, so the reading order and the list hierarchy stay those of the source. `origin` is the
  // absolute offset of `source`, which turns a task marker's own offset back into a note position.
  const emit = (node: SyntaxNode, parent: Node) => {
    if (insideRanges(containers, node.from)) {
      parent.appendChild(element('p', 'cm-live-literal', source.slice(node.from, node.to)));
      return;
    }
    switch (node.name) {
      case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3': case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6':
      case 'SetextHeading1': case 'SetextHeading2': {
        const heading = element(`h${Math.min(6, Math.max(1, Number(node.name.at(-1))))}`);
        const content = headingRange(node, source);
        appendInlineRange(heading, node, content.from, content.to, source, host);
        parent.appendChild(heading);
        return;
      }
      case 'Paragraph': {
        const paragraph = element('p');
        appendInline(paragraph, node, source, host);
        parent.appendChild(paragraph);
        return;
      }
      case 'Task': {
        const marker = node.getChild('TaskMarker');
        if (!marker) { parent.appendChild(element('p', 'cm-live-literal', source.slice(node.from, node.to))); return; }
        const holder = element('p', 'cm-live-task-item');
        holder.appendChild(markerCheckbox(origin + marker.from, marker, source, host));
        appendInlineRange(holder, node, marker.to, node.to, source, host);
        parent.appendChild(holder);
        return;
      }
      case 'BulletList': case 'OrderedList': {
        const list = element(node.name === 'BulletList' ? 'ul' : 'ol') as HTMLUListElement | HTMLOListElement;
        if (node.name === 'OrderedList') {
          const start = orderedStart(node, source);
          if (start !== null && start !== 1) (list as HTMLOListElement).start = start;
        }
        for (let item = node.firstChild; item; item = item.nextSibling) {
          if (item.name !== 'ListItem') continue;
          const li = element('li');
          const content = firstContent(item);
          // A shorthand task is the note plan's own rule for a list block and only applies to the item's first
          // content, so the body recognises the same source text here instead of a second spelling of it.
          const shorthand = content && content.name === 'Paragraph' && !insideRanges(containers, item.from)
            ? shorthandTaskRange(source.slice(item.from, content.to)) : null;
          if (content && shorthand) {
            const markerTo = item.from + shorthand.to;
            const after = source[markerTo] === ' ' ? markerTo + 1 : markerTo;
            const holder = element('p', 'cm-live-task-item');
            holder.appendChild(snippetCheckbox(origin + item.from + shorthand.from, shorthand.checked, after, source, host));
            appendInlineRange(holder, content, markerTo, content.to, source, host);
            li.appendChild(holder);
          }
          for (let child = item.firstChild; child; child = child.nextSibling) {
            if (child.name === 'ListMark' || child.name === 'QuoteMark') continue;
            if (shorthand && child === content) continue;
            emit(child, li);
          }
          if (li.childNodes.length) list.appendChild(li);
        }
        parent.appendChild(list);
        return;
      }
      case 'Blockquote': {
        // A quote holds blocks, not one paragraph: its lists, nested quotes and fences are rebuilt as their own
        // structure, and only its own `QuoteMark`s disappear.
        const quote = element('blockquote');
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== 'QuoteMark') emit(child, quote);
        }
        parent.appendChild(quote);
        return;
      }
      case 'FencedCode': case 'CodeBlock': {
        const body = codeBody(node, sliceOf(source));
        const pre = element('pre', 'cm-live-code-plain');
        pre.appendChild(element('code', '', body ? body.text : ''));
        parent.appendChild(pre);
        return;
      }
      case 'Table':
        parent.appendChild(buildTable(tableData(sliceOf(source), node), host));
        return;
      case 'HorizontalRule':
        parent.appendChild(element('hr'));
        return;
      case 'HTMLBlock': case 'LinkReference':
        // Raw HTML and link definitions stay literal; the live surface never interprets user HTML.
        parent.appendChild(element('p', 'cm-live-literal', source.slice(node.from, node.to)));
        return;
      default: {
        let child = node.firstChild;
        if (!child) { parent.appendChild(element('p', 'cm-live-literal', source.slice(node.from, node.to))); return; }
        for (; child; child = child.nextSibling) emit(child, parent);
      }
    }
  };
  for (let child = tree.firstChild; child; child = child.nextSibling) emit(child, fragment);
  return fragment;
}

function drain<T>(iterator: Generator<void, T>): T {
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

function scanNestedDetails(source: string): DetailsRange[] {
  return drain(scanDetailsSteps(textLines(source), snippetScanContext(source))).ranges;
}

/**
 * The `open` state a `<details>` element was last given. A programmatic change (an in-place widget update) fires
 * the same `toggle` event as a user click, and that must not be written back as a new fold decision.
 */
const appliedOpen = new WeakMap<HTMLDetailsElement, boolean>();

function detailsElement(
  range: { open: boolean; summary: string; body: string; bodyFrom: number }, host: LiveWidgetHost, depth: number,
  owner: { from: number; identity: string }, key: string,
  /** Absolute offset of the scanned source, which makes `range.bodyFrom` a note position. */
  base: number,
): HTMLElement {
  const details = document.createElement('details');
  details.open = host.folded(owner.from, key, owner.identity, range.open);
  appliedOpen.set(details, details.open);
  const summary = document.createElement('summary');
  summary.textContent = range.summary || t('details_summary');
  details.appendChild(summary);
  const body = element('div', 'cm-live-details-body');
  body.appendChild(detailsBody(range.body, host, depth + 1, owner, base + range.bodyFrom));
  details.appendChild(body);
  details.addEventListener('toggle', () => {
    if (appliedOpen.get(details) === details.open) return;
    appliedOpen.set(details, details.open);
    host.fold(owner.from, key, owner.identity, details.open);
  });
  return details;
}

// The body is Markdown again, so a nested standalone details block is rebuilt here and stays foldable on its
// own; other raw HTML in the body keeps being literal text. Its own source is the state key, so an outer
// rebuild or an outer toggle does not reset it. `base` is the note offset of `source`'s first character.
function detailsBody(
  source: string, host: LiveWidgetHost, depth: number, owner: { from: number; identity: string }, base: number,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!source.trim() || depth > 8) {
    if (source) fragment.appendChild(element('p', 'cm-live-literal', source));
    return fragment;
  }
  const nested = scanNestedDetails(source);
  let cursor = 0;
  for (const range of nested) {
    if (range.from > cursor) fragment.appendChild(parseBlocks(source.slice(cursor, range.from), host, base + cursor));
    // The key carries the offset inside the body, so two identical siblings keep separate fold state.
    const key = `${range.from}:${source.slice(range.from, range.to)}`;
    fragment.appendChild(detailsElement(range, host, depth, owner, key, base));
    cursor = range.to;
  }
  if (cursor < source.length) fragment.appendChild(parseBlocks(source.slice(cursor), host, base + cursor));
  return fragment;
}

type KatexModule = typeof import('katex');
let katexModule: Promise<KatexModule> | null = null;
let katexUnavailable = false;
// A failed chunk load is remembered as "unavailable" instead of a cached null module: every formula then takes
// the source-recovery branch instead of staying blank, and the network request is not retried on each keystroke.
const loadKatex = () => {
  if (katexUnavailable) return Promise.reject(new Error('katex-unavailable'));
  return (katexModule ??= import('katex').then((module) => module).catch((error) => {
    katexUnavailable = true;
    katexModule = null;
    throw error;
  }));
};

const mathTags = new Set([
  'math', 'mrow', 'mi', 'mo', 'mn', 'mtext', 'mspace', 'ms', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'mtable', 'mtr', 'mtd',
  'mlabeledtr', 'munder', 'mover', 'munderover', 'msub', 'msup', 'msubsup', 'mfenced', 'mpadded', 'mphantom', 'menclose',
  'semantics', 'annotation', 'mmultiscripts', 'mprescripts', 'none',
]);
const mathAttributes = new Set([
  'display', 'mathvariant', 'scriptlevel', 'displaystyle', 'stretchy', 'lspace', 'rspace', 'movablelimits', 'fence',
  'separator', 'linethickness', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines',
  'frame', 'framespacing', 'width', 'height', 'depth', 'symmetric', 'form', 'notation', 'bevelled', 'largeop', 'minsize',
  'maxsize', 'open', 'close', 'separators', 'voffset', 'accent', 'accentunder', 'scriptminsize',
]);

function copyMathml(source: Element, target: Element) {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (!(child instanceof Element)) continue;
    const name = child.localName.toLocaleLowerCase();
    if (!mathTags.has(name)) continue;
    if (name === 'annotation') {
      if (child.getAttribute('encoding') !== 'application/x-tex') continue;
      const annotation = document.createElementNS(mathNamespace, 'annotation');
      annotation.setAttribute('encoding', 'application/x-tex');
      annotation.textContent = child.textContent ?? '';
      target.appendChild(annotation);
      continue;
    }
    const copy = document.createElementNS(mathNamespace, name);
    for (const attribute of Array.from(child.attributes)) {
      if (mathAttributes.has(attribute.name)) copy.setAttribute(attribute.name, attribute.value);
    }
    copyMathml(child, copy);
    target.appendChild(copy);
  }
}

function renderMath(tex: string, display: boolean, container: HTMLElement, alive: () => boolean) {
  if (tex.length > MAX_FORMULA_LENGTH) return Promise.reject(new Error('formula-too-long'));
  return loadKatex().then((module) => {
    if (!alive()) return;
    const holder = document.createElement('div');
    module.default.render(tex, holder, {
      displayMode: display, output: 'mathml', trust: false, throwOnError: true, maxExpand: 1000, maxSize: 20,
    });
    // katex.render wraps MathML output in a span.katex container; the MathML root is inside it.
    const root = holder.querySelector('math');
    if (!root) throw new Error('mathml-missing');
    const math = document.createElementNS(mathNamespace, 'math');
    for (const attribute of Array.from(root.attributes)) {
      if (mathAttributes.has(attribute.name)) math.setAttribute(attribute.name, attribute.value);
    }
    math.setAttribute('xmlns', mathNamespace);
    copyMathml(root, math);
    container.textContent = '';
    container.appendChild(math);
  });
}

let highlighterModule: Promise<{ highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string }; getLanguage(name: string): unknown } | null> | null = null;
const loadHighlighter = () => (highlighterModule ??= import('highlight.js/lib/common').then((module) => module.default).catch(() => null));
const highlightClass = /^hljs(?:-[a-z0-9_-]+)?$/i;

// highlight.js output is a trusted temporary markup string, but the editor still rebuilds it from a
// sanitized, explicitly configured pass so widget DOM never adopts arbitrary tags or attributes.
async function highlighted(pre: HTMLElement, code: string, language: string, alive: () => boolean) {
  const highlighter = await loadHighlighter();
  if (!highlighter || !alive() || !language || !highlighter.getLanguage(language)) return;
  let value = '';
  try {
    value = highlighter.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return;
  }
  const clean = DOMPurify.sanitize(value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'], ALLOW_DATA_ATTR: false });
  const parsed = new DOMParser().parseFromString(clean, 'text/html');
  const rebuilt = document.createElement('code');
  rebuilt.className = 'hljs';
  const copy = (source: Node, target: Node) => {
    for (const child of Array.from(source.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) target.appendChild(document.createTextNode(child.nodeValue ?? ''));
      else if (child instanceof Element && child.tagName === 'SPAN') {
        const span = document.createElement('span');
        const classes = (child.getAttribute('class') ?? '').split(/\s+/).filter((name) => highlightClass.test(name));
        if (classes.length) span.className = classes.join(' ');
        copy(child, span);
        target.appendChild(span);
      }
    }
  };
  copy(parsed.body, rebuilt);
  if (!alive()) return;
  pre.textContent = '';
  pre.appendChild(rebuilt);
}

export class CodeBlockWidget extends WidgetType {
  constructor(readonly source: string, readonly language: string, readonly from: number, readonly to: number, readonly host: LiveWidgetHost) { super(); }
  eq(other: CodeBlockWidget) { return other.source === this.source && other.language === this.language && other.from === this.from; }
  get estimatedHeight() { return Math.min(600, 40 + this.source.split('\n').length * 24); }
  // Events must still reach the editor so a click can expose the block source or run a control action;
  // every other event (keyboard, input) stays with the widget's own DOM.
  ignoreEvent(event: Event) { return event.type !== 'mousedown'; }
  toDOM() {
    return guarded(() => {
      const wrapper = stamp(element('div', 'cm-live-widget cm-live-code'), this.from);
      wrapper.title = t('edit_rendered_block');
      if (this.language) wrapper.appendChild(element('div', 'cm-live-code-language', this.language));
      const pre = element('pre');
      const code = this.source.replace(/\n$/, '');
      pre.appendChild(element('code', 'hljs', code));
      wrapper.appendChild(pre);
      let alive = true;
      (wrapper as HTMLElement & { destroy?: () => void }).destroy = () => { alive = false; };
      void highlighted(pre, code, this.language, () => alive).catch(() => undefined);
      return wrapper;
    }, this.source, () => this.host.expose(this.from, this.to));
  }
  destroy(dom: HTMLElement) { (dom as HTMLElement & { destroy?: () => void }).destroy?.(); }
}

export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean, readonly from: number, readonly to: number, readonly host: LiveWidgetHost) { super(); }
  eq(other: MathWidget) { return other.tex === this.tex && other.display === this.display && other.from === this.from; }
  get estimatedHeight() { return this.display ? 80 : -1; }
  // Events must still reach the editor so a click can expose the block source or run a control action;
  // every other event (keyboard, input) stays with the widget's own DOM.
  ignoreEvent(event: Event) { return event.type !== 'mousedown'; }
  toDOM() {
    return guarded(() => {
      const holder = stamp(element(this.display ? 'div' : 'span', `cm-live-widget cm-live-math${this.display ? ' cm-live-math-display' : ''}`), this.from);
      let alive = true;
      (holder as HTMLElement & { destroy?: () => void }).destroy = () => { alive = false; };
      renderMath(this.tex, this.display, holder, () => alive).catch(() => {
        if (!alive) return;
        // A missing KaTeX chunk, an invalid formula or an oversized one all reveal the source instead of a blank.
        this.host.expose(this.from, this.to);
        this.host.notify(t('math_render_failed'));
      });
      return holder;
    }, this.tex, () => this.host.expose(this.from, this.to));
  }
  destroy(dom: HTMLElement) { (dom as HTMLElement & { destroy?: () => void }).destroy?.(); }
}

export class TableWidget extends WidgetType {
  constructor(readonly table: LiveTableData, readonly from: number, readonly to: number, readonly source: string, readonly host: LiveWidgetHost) { super(); }
  eq(other: TableWidget) { return other.source === this.source && other.from === this.from; }
  get estimatedHeight() { return 40 + (this.table.rows.length + 1) * 32; }
  // Events must still reach the editor so a click can expose the block source or run a control action;
  // every other event (keyboard, input) stays with the widget's own DOM.
  ignoreEvent(event: Event) { return event.type !== 'mousedown'; }
  toDOM() {
    return guarded(() => {
      const wrapper = stamp(element('div', 'cm-live-widget cm-live-table-wrap'), this.from);
      wrapper.title = t('edit_rendered_block');
      wrapper.appendChild(buildTable(this.table, this.host));
      return wrapper;
    }, this.source, () => this.host.expose(this.from, this.to));
  }
}

export class RuleWidget extends WidgetType {
  constructor(readonly from: number) { super(); }
  eq(other: RuleWidget) { return other.from === this.from; }
  get estimatedHeight() { return 24; }
  // Events must still reach the editor so a click can expose the block source or run a control action;
  // every other event (keyboard, input) stays with the widget's own DOM.
  ignoreEvent(event: Event) { return event.type !== 'mousedown'; }
  toDOM() {
    const wrapper = stamp(element('div', 'cm-live-widget cm-live-rule'), this.from);
    wrapper.appendChild(element('hr'));
    return wrapper;
  }
}

export class DetailsWidget extends WidgetType {
  constructor(
    readonly source: string, readonly summary: string, readonly body: string, readonly open: boolean,
    readonly from: number, readonly to: number, readonly host: LiveWidgetHost, readonly identity: string,
    /** Absolute note offset of `body`'s first character, so a task inside it keeps its own position. */
    readonly bodyFrom: number,
  ) { super(); }
  eq(other: DetailsWidget) {
    return other.source === this.source && other.open === this.open && other.from === this.from && other.identity === this.identity;
  }
  // Opening or closing only changes one attribute of the existing control. Rebuilding it would remove the
  // summary that has the keyboard focus, so a second Enter/Space press would go nowhere.
  updateDOM(dom: HTMLElement, _view: EditorView, previous: DetailsWidget) {
    if (previous.source !== this.source || previous.from !== this.from || previous.identity !== this.identity) return false;
    const details = dom.querySelector('details');
    if (!details) return false;
    if (details.open !== this.open) {
      appliedOpen.set(details, this.open);
      details.open = this.open;
    }
    return true;
  }
  get estimatedHeight() { return this.open ? 120 : 36; }
  // Events must still reach the editor so a click can expose the block source or run a control action;
  // every other event (keyboard, input) stays with the widget's own DOM.
  ignoreEvent(event: Event) { return event.type !== 'mousedown'; }
  toDOM() {
    return guarded(() => {
      const wrapper = stamp(element('div', 'cm-live-widget cm-live-details'), this.from);
      wrapper.title = t('edit_details_block');
      const details = detailsElement(
        { open: this.open, summary: this.summary, body: this.body, bodyFrom: this.bodyFrom },
        this.host, 0, { from: this.from, identity: this.identity }, '', 0,
      ) as HTMLDetailsElement;
      wrapper.appendChild(details);
      return wrapper;
    }, this.source, () => this.host.expose(this.from, this.to));
  }
}

function imageButton(widget: { id: string; src: string; alt: string }): { button: HTMLButtonElement; image: HTMLImageElement } {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cm-live-image-button';
  button.dataset.liveAction = 'image';
  button.dataset.imageId = widget.id;
  button.dataset.imageSrc = widget.src;
  button.setAttribute('aria-label', t('zoom_image', widget.alt || widget.id));
  const image = document.createElement('img');
  image.alt = widget.alt;
  image.loading = 'lazy';
  image.src = widget.src;
  button.appendChild(image);
  return { button, image };
}

// A private image gets exactly one cache attempt. Anything that still fails afterwards removes the replacement
// and shows the Markdown source, so the note stays editable instead of holding a broken picture.
function watchImage(wrapper: HTMLElement, image: HTMLImageElement, id: string, fail: () => void, host: LiveWidgetHost) {
  let attempted = false;
  const useCached = () => {
    if (attempted) return;
    attempted = true;
    const resolve = host.resolveFile;
    if (!resolve) { fail(); return; }
    void resolve(id).then((url) => {
      if (!url) { fail(); return; }
      if (!image.isConnected) { URL.revokeObjectURL(url); return; }
      ownUrl(wrapper, url);
      image.addEventListener('error', fail, { once: true });
      image.src = url;
      host.requestMeasure();
    }).catch(() => fail());
  };
  image.addEventListener('error', useCached);
  if (image.complete && image.naturalWidth === 0) useCached();
}

export class ImageWidget extends WidgetType {
  constructor(readonly id: string, readonly src: string, readonly alt: string, readonly source: string, readonly from: number, readonly to: number, readonly host: LiveWidgetHost) { super(); }
  eq(other: ImageWidget) { return other.src === this.src && other.alt === this.alt && other.from === this.from && other.source === this.source; }
  get estimatedHeight() { return 220; }
  // Events must still reach the editor so a click can expose the block source or run a control action;
  // every other event (keyboard, input) stays with the widget's own DOM.
  ignoreEvent(event: Event) { return event.type !== 'mousedown'; }
  toDOM() {
    return guarded(() => {
      const wrapper = stamp(element('div', 'cm-live-widget cm-live-image'), this.from);
      const { button, image } = imageButton(this);
      image.className = 'cm-live-image-el';
      wrapper.appendChild(button);
      const fail = () => {
        if (!button.isConnected) return;
        this.host.notify(t('image_unavailable'));
        this.host.expose(this.from, this.to);
      };
      watchImage(wrapper, image, this.id, fail, this.host);
      return wrapper;
    }, this.source, () => this.host.expose(this.from, this.to));
  }
  destroy(dom: HTMLElement) { releaseUrls(dom); }
}

export class InlineImageWidget extends WidgetType {
  constructor(readonly id: string, readonly src: string, readonly alt: string, readonly from: number, readonly to: number, readonly host: LiveWidgetHost) { super(); }
  eq(other: InlineImageWidget) { return other.src === this.src && other.alt === this.alt && other.from === this.from; }
  // Events must still reach the editor so a click can expose the block source or run a control action;
  // every other event (keyboard, input) stays with the widget's own DOM.
  ignoreEvent(event: Event) { return event.type !== 'mousedown'; }
  toDOM() {
    const wrapper = element('span', 'cm-live-inline-image');
    const { button, image } = imageButton(this);
    wrapper.appendChild(button);
    const fail = () => {
      if (!button.isConnected) return;
      this.host.notify(t('image_unavailable'));
      this.host.expose(this.from, this.to);
    };
    watchImage(wrapper, image, this.id, fail, this.host);
    return wrapper;
  }
  destroy(dom: HTMLElement) { releaseUrls(dom); }
}

/**
 * A rendered task. `from` is the absolute offset of its `[`, so the write-back names one note position instead of
 * a line inside whatever source the checkbox was built from.
 */
function taskCheckbox(from: number, checked: boolean, label: string, host: LiveWidgetHost): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'cm-live-task';
  input.checked = checked;
  input.dataset.liveAction = 'task';
  const line = host.sourceLine(from);
  if (line !== null) input.dataset.taskLine = String(line);
  input.setAttribute('aria-label', t('待办事项：{0}', label || t('未命名')));
  input.addEventListener('change', () => host.onTask(from, input.checked));
  return input;
}

/** A checkbox whose label is the rest of its marker's line in `source`; `from` is its absolute note offset. */
function snippetCheckbox(from: number, checked: boolean, after: number, source: string, host: LiveWidgetHost): HTMLInputElement {
  const end = source.indexOf('\n', after);
  const label = source.slice(after, end < 0 ? source.length : end).replace(/[*_~`[\]]/g, '').trim().slice(0, 120);
  return taskCheckbox(from, checked, label, host);
}

/** The same checkbox for a task node of a snippet, read from that snippet and positioned by `from`. */
function markerCheckbox(from: number, marker: SyntaxNode, source: string, host: LiveWidgetHost): HTMLInputElement {
  const after = source.slice(marker.to, marker.to + 1) === ' ' ? marker.to + 1 : marker.to;
  return snippetCheckbox(from, /\[[xX]\]/.test(source.slice(marker.from, marker.to)), after, source, host);
}

export class TaskWidget extends WidgetType {
  constructor(readonly from: number, readonly checked: boolean, readonly label: string, readonly host: LiveWidgetHost) { super(); }
  eq(other: TaskWidget) {
    return other.from === this.from && other.checked === this.checked && other.label === this.label;
  }
  // Events must still reach the editor so a click can expose the block source or run a control action;
  // every other event (keyboard, input) stays with the widget's own DOM.
  ignoreEvent(event: Event) { return event.type !== 'mousedown'; }
  toDOM() { return taskCheckbox(this.from, this.checked, this.label, this.host); }
}

export class WikiLinkWidget extends WidgetType {
  constructor(readonly id: string, readonly label: string, readonly from: number) { super(); }
  eq(other: WikiLinkWidget) { return other.id === this.id && other.label === this.label && other.from === this.from; }
  // Events must still reach the editor so a click can expose the block source or run a control action;
  // every other event (keyboard, input) stays with the widget's own DOM.
  ignoreEvent(event: Event) { return event.type !== 'mousedown'; }
  toDOM() {
    const anchor = document.createElement('a');
    anchor.className = 'cm-live-wikilink';
    anchor.dataset.liveAction = 'note';
    anchor.dataset.noteId = this.id;
    anchor.href = `#note-${this.id}`;
    anchor.textContent = this.label;
    return anchor;
  }
}
