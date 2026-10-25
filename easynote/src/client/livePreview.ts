import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate, type WidgetType } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNodeRef } from '@lezer/common';
import { searchMatchRanges, searchQueryFacet } from './editorSearch';
import { t } from './i18n';
import {
  analyzeLiveMarkdownSteps, MAX_PLAN_MILLISECONDS, labelRange, shorthandTaskRange, type LiveBlock,
  type LiveMarkdownPlan,
} from './livePreviewSyntax';
import {
  CodeBlockWidget, DetailsWidget, ImageWidget, InlineImageWidget, MathWidget, RuleWidget, TableWidget, TaskWidget,
  WikiLinkWidget, type LiveWidgetHost,
} from './livePreviewWidgets';
import {
  autolinkHref, markdownTarget, privateFileId, privateImageId, safeMarkdownHref,
} from './markdownResources';

export type LiveEditorMode = 'source' | 'live';

export interface LivePreviewOptions {
  /** MarkdownIt's own link validator, so both reading and the editor reject the same targets. */
  validateLink(source: string): boolean;
  onImage(src: string, release?: () => void): void;
  onNote(id: string): void;
  onFile(id: string, href: string): void;
  resolveFile?(): ((id: string) => Promise<string | null>) | undefined;
  onRenderFallback?(reason: 'error' | 'budget' | 'size'): void;
  onStatus?(message: string): void;
  /** UTF-8 byte budget check owned by the editor, so the plan never renders an oversized draft. */
  bytesOverLimit?(): boolean;
}

export const livePreviewMode = Facet.define<LiveEditorMode, LiveEditorMode>({
  combine: (values) => values.at(-1) ?? 'source',
});

export const livePreviewActive = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? false,
});

const livePreviewHost = Facet.define<LiveWidgetHost, LiveWidgetHost | null>({
  combine: (values) => values[0] ?? null,
});

/** Installs a plan computed by `analyzeLiveMarkdownSteps`; the dirty region it covered stops being source. */
export const setPlanEffect = StateEffect.define<LiveMarkdownPlan | null>();
const exposeEffect = StateEffect.define<{ from: number; to: number }[] | null>();
const foldEffect = StateEffect.define<FoldState>();

/**
 * Collapse state belongs to one block: the mapped position and the owning block's source identify it together. A
 * same-length replacement or a new block with identical source therefore starts from its own `open` attribute,
 * while a block that moves keeps its state. A nested block adds a positional key of its own, so two identical
 * nested siblings keep separate state.
 */
interface FoldState {
  from: number;
  to: number;
  /** '' for the top-level block, otherwise the nested block's offset and source inside the body. */
  key: string;
  /** Source text of the owning details block; a same-length replacement must not inherit the state. */
  identity: string;
  open: boolean;
}

function foldedValue(folding: FoldState[], from: number, to: number, key: string, identity: string): boolean | undefined {
  const matches = folding.filter((fold) => fold.from === from && fold.to === to && fold.key === key && fold.identity === identity);
  return matches.length === 1 ? matches[0].open : undefined;
}

interface LiveState {
  mode: LiveEditorMode;
  active: boolean;
  plan: LiveMarkdownPlan | null;
  exposed: { from: number; to: number }[];
  dirty: { from: number; to: number }[];
  folding: FoldState[];
  /** Set when a state update had to be abandoned; the controller turns it into a source fallback. */
  crashed: boolean;
}

const emptyState = (mode: LiveEditorMode, active: boolean, folding: FoldState[] = []): LiveState => ({
  mode, active, plan: null, exposed: [], dirty: [], folding, crashed: false,
});

function remapBlock(block: LiveBlock, doc: Text, changes: { mapPos(position: number, assoc: number): number }): LiveBlock {
  const from = changes.mapPos(block.from, -1);
  const to = changes.mapPos(block.to, 1);
  return {
    ...block,
    from,
    to,
    line: doc.lineAt(from).number - 1,
    endLine: doc.lineAt(Math.min(to, doc.length)).number - 1,
    // A details body keeps naming absolute positions, so the tasks inside a block that only moved stay correct.
    details: block.details
      ? { ...block.details, bodyFrom: changes.mapPos(block.details.bodyFrom, -1) }
      : undefined,
    inline: block.inline
      .map((span) => ({ ...span, from: changes.mapPos(span.from, -1), to: changes.mapPos(span.to, 1) }))
      .filter((span) => span.to > span.from),
  };
}

function mergedRanges(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
  const merged: { from: number; to: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * The plan survives a document change by mapping: untouched blocks keep their description and are reused by the
 * next plan, while every block the change reaches is dropped to source at once and folded into `dirty`. `dirty`
 * therefore names the whole region the next plan has to describe again.
 */
export const livePreviewState = StateField.define<LiveState>({
  create: (state) => emptyState(state.facet(livePreviewMode), state.facet(livePreviewActive)),
  update(value, transaction) {
    const mode = transaction.state.facet(livePreviewMode);
    const active = transaction.state.facet(livePreviewActive);
    try {
      let plan = value.plan;
      let exposed = value.exposed;
      let dirty = value.dirty;
      let folding = value.folding;
      if (transaction.docChanged) {
        dirty = dirty
          .map((range) => ({ from: transaction.changes.mapPos(range.from, -1), to: transaction.changes.mapPos(range.to, 1) }))
          .filter((range) => range.to > range.from);
        transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
          dirty.push({ from: Math.max(0, fromB - 1), to: Math.min(transaction.state.doc.length, toB + 1) });
        });
        exposed = exposed
          .map((range) => ({ from: transaction.changes.mapPos(range.from, -1), to: transaction.changes.mapPos(range.to, 1) }))
          .filter((range) => range.to > range.from);
        folding = folding
          .map((fold) => ({
            ...fold,
            // An insertion exactly at the block start belongs to the block, so the state moves with it.
            from: transaction.changes.mapPos(fold.from, 1),
            to: transaction.changes.mapPos(fold.to, 1),
          }))
          .filter((fold) => fold.to > fold.from);
        if (plan) {
          const blocks: LiveBlock[] = [];
          for (const block of plan.blocks) {
            const from = transaction.changes.mapPos(block.from, -1);
            const to = transaction.changes.mapPos(block.to, 1);
            if (to <= from) continue;
            // A block that contains the change is dropped instead of being reused with stale line metadata.
            if (dirty.some((range) => range.from < to && range.to > from)) {
              dirty.push({ from, to });
              continue;
            }
            blocks.push(remapBlock(block, transaction.state.doc, transaction.changes));
          }
          dirty = mergedRanges(dirty);
          const mapRanges = (ranges: { from: number; to: number }[]) => ranges
            .map((range) => ({
              from: transaction.changes.mapPos(range.from, -1),
              to: transaction.changes.mapPos(range.to, 1),
            }))
            .filter((range) => range.to > range.from);
          plan = {
            ...plan, doc: transaction.state.doc, docLength: transaction.state.doc.length, blocks,
            html: mapRanges(plan.html), math: mapRanges(plan.math), details: mapRanges(plan.details),
            openDetails: mapRanges(plan.openDetails), missing: mapRanges(plan.missing),
          };
        }
      }
      for (const effect of transaction.effects) {
        if (effect.is(setPlanEffect)) {
          plan = effect.value;
          dirty = [];
        } else if (effect.is(exposeEffect)) exposed = effect.value ? effect.value.map((range) => ({ ...range })) : [];
        else if (effect.is(foldEffect)) {
          folding = folding.filter((fold) => fold.from !== effect.value.from || fold.to !== effect.value.to ||
            fold.key !== effect.value.key || fold.identity !== effect.value.identity);
          folding.push({ ...effect.value });
        }
      }
      return { mode, active, plan, exposed, dirty, folding, crashed: false };
    } catch {
      // A decoration helper that throws must not escape the transaction: it would skip onChange/save.
      return { ...emptyState(mode, active, value.folding), crashed: true };
    }
  },
});

function activeBlocks(state: EditorState, value: LiveState): (block: LiveBlock) => boolean {
  const matches = searchMatchRanges(state);
  const selection = state.selection.ranges;
  return (block) => {
    for (const range of selection) {
      if (range.empty) {
        if (range.head >= block.from && range.head <= block.to) return true;
      } else if (range.from < block.to && range.to > block.from) return true;
    }
    if (matches.some((match) => match.from < block.to && match.to > block.from)) return true;
    if (value.exposed.some((range) => range.from < block.to && range.to > block.from)) return true;
    return value.dirty.some((range) => range.from < block.to && range.to > block.from);
  };
}

function imageWidget(block: LiveBlock, host: LiveWidgetHost) {
  const match = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)$/.exec(block.text.trim());
  if (!match) return null;
  const id = privateImageId(match[2]);
  if (!id) return null;
  // The whitelisted path is the image's own target, without a `<…>` shell the syntax may have around it.
  const src = markdownTarget(match[2]);
  return new ImageWidget(id, src, match[1], block.text, block.from, block.to, host);
}

/** Fold state of a whole details block, matched by its mapped position and its source. */
function blockFold(folding: FoldState[], block: LiveBlock): boolean | undefined {
  return foldedValue(folding, block.from, block.to, '', block.text);
}

function blockWidget(block: LiveBlock, host: LiveWidgetHost, folding: FoldState[]) {
  switch (block.kind) {
    case 'code': return new CodeBlockWidget(block.codeText ?? block.text, block.language ?? '', block.from, block.to, host);
    case 'math': return new MathWidget(block.mathTex ?? '', true, block.from, block.to, host);
    case 'table': return block.table ? new TableWidget(block.table, block.from, block.to, block.text, host) : null;
    case 'rule': return new RuleWidget(block.from);
    case 'details':
      return block.details
        ? new DetailsWidget(block.text, block.details.summary, block.details.body,
          blockFold(folding, block) ?? block.details.open, block.from, block.to, host, block.text,
          block.details.bodyFrom)
        : null;
    case 'image': return imageWidget(block, host);
    default: return null;
  }
}

function lineDecorations(state: EditorState, block: LiveBlock): Range<Decoration>[] {
  const classes: string[] = [];
  if (block.kind === 'heading') classes.push('cm-live-heading', `cm-live-h${Math.min(6, Math.max(1, block.headingLevel))}`);
  else if (block.kind === 'list' || block.kind === 'task') classes.push('cm-live-list');
  else if (block.kind === 'code') classes.push('cm-live-code-source');
  if (block.quoteDepth > 0) classes.push('cm-live-quote');
  if (!classes.length) return [];
  const classNames = classes.join(' ');
  const ranges: Range<Decoration>[] = [];
  // A Setext heading's underline line is replaced by the field, so only its first line is styled.
  const last = block.kind === 'heading' ? block.line : block.endLine;
  for (let line = block.line + 1; line <= last + 1; line++) {
    if (line > state.doc.lines) break;
    const from = state.doc.line(line).from;
    // The heading stays a heading for assistive technology while its Markdown marker is hidden.
    ranges.push(block.kind === 'heading'
      ? Decoration.line({ class: classNames, attributes: { role: 'heading', 'aria-level': String(Math.min(6, Math.max(1, block.headingLevel))) } }).range(from)
      : Decoration.line({ class: classNames }).range(from));
  }
  return ranges;
}

// Hiding the Setext underline needs a replacement that covers a line break, so it comes from the field. The line
// is found through the heading's own `HeaderMark`: a quote or a list item writes a container prefix in front of
// the `---`, so testing the raw line against a bare marker would leave the underline right where it is.
function setextUnderline(state: EditorState, block: LiveBlock): Range<Decoration>[] {
  if (block.kind !== 'heading' || block.endLine === block.line) return [];
  let underline = -1;
  syntaxTree(state).iterate({
    from: block.from,
    to: block.to,
    enter: (node) => {
      if (node.name !== 'HeaderMark' || !(node.node.parent?.name ?? '').startsWith('SetextHeading')) return;
      underline = node.from;
      return false;
    },
  });
  if (underline < 0) return [];
  const line = state.doc.lineAt(underline);
  // The underline is the line below the heading text; its replacement starts at the preceding line break, so the
  // whole line disappears instead of leaving an empty prefixed line behind.
  if (line.number - 1 <= block.line) return [];
  return [Decoration.replace({}).range(line.from - 1, line.to)];
}

let decorationFailure = false;

function buildBlockDecorations(state: EditorState): DecorationSet {
  const value = state.field(livePreviewState);
  if (state.facet(livePreviewMode) !== 'live' || !state.facet(livePreviewActive)) return Decoration.none;
  if (!value.plan || value.plan.doc !== state.doc) return Decoration.none;
  const host = state.facet(livePreviewHost);
  const isActive = activeBlocks(state, value);
  const ranges: Range<Decoration>[] = [];
  let lastTo = -1;
  for (const block of value.plan.blocks) {
    if (isActive(block)) continue;
    if (block.block) {
      if (block.from < lastTo) continue;
      const widget = host ? blockWidget(block, host, value.folding) : null;
      if (!widget) continue;
      ranges.push(Decoration.replace({ widget, block: true, inclusive: false }).range(block.from, block.to));
      lastTo = block.to;
      continue;
    }
    ranges.push(...lineDecorations(state, block), ...setextUnderline(state, block));
  }
  return Decoration.set(ranges, true);
}

const blockDecorations = EditorView.decorations.compute(
  ['doc', 'selection', livePreviewState, livePreviewMode, livePreviewActive, searchQueryFacet, livePreviewHost],
  (state) => {
    try {
      return buildBlockDecorations(state);
    } catch {
      decorationFailure = true;
      return Decoration.none;
    }
  },
);

const hiddenMark = Decoration.replace({});
const strongMark = Decoration.mark({ tagName: 'strong', class: 'cm-live-strong' });
const emphasisMark = Decoration.mark({ tagName: 'em', class: 'cm-live-em' });
const strikeMark = Decoration.mark({ tagName: 'del', class: 'cm-live-del' });
const codeMark = Decoration.mark({ tagName: 'code', class: 'cm-live-inline-code' });

function inlineForBlock(
  state: EditorState, block: LiveBlock, from: number, to: number, host: LiveWidgetHost,
  ranges: Range<Decoration>[], atomic: Range<Decoration>[],
) {
  const doc = state.doc;
  // CodeMirror rejects a plugin replacement that covers a line break, and that check runs while the document
  // view updates — after the decoration builders returned, so a catch here cannot help. Every indirect
  // replacement goes through this single outlet: a range that contains a line break keeps its Markdown source.
  const place = (decoration: Decoration, start: number, end: number) => {
    if (end <= start) return;
    if (doc.sliceString(start, end).includes('\n')) return;
    ranges.push(decoration.range(start, end));
    atomic.push(decoration.range(start, end));
  };
  const hide = (start: number, end: number) => place(hiddenMark, start, end);
  const replace = (start: number, end: number, widget: WidgetType) =>
    place(Decoration.replace({ widget, inclusive: false }), start, end);
  // `- []` and continuation forms are not TaskList tasks in lezer, but the reading surface already treats
  // them as checkboxes, so the same source rule is applied here on the item's own lines.
  if (block.kind === 'list') {
    const shorthand = shorthandTaskRange(block.text);
    if (shorthand) {
      const start = block.from + shorthand.from;
      const markerTo = block.from + shorthand.to;
      const line = doc.lineAt(start);
      const end = doc.sliceString(markerTo, Math.min(markerTo + 1, line.to)) === ' ' ? markerTo + 1 : markerTo;
      const label = line.text.slice(end - line.from).replace(/[*_~`[\]]/g, '').trim().slice(0, 120);
      replace(start, end, new TaskWidget(start, shorthand.checked, label, host));
    }
  }
  syntaxTree(state).iterate({
    from, to,
    enter: (node: SyntaxNodeRef) => {
      switch (node.name) {
        case 'HeaderMark': {
          if ((node.node.parent?.name ?? '').startsWith('ATXHeading')) {
            const line = doc.lineAt(node.from);
            hide(node.from, node.to + (doc.sliceString(node.to, Math.min(node.to + 1, line.to)) === ' ' ? 1 : 0));
          }
          return false;
        }
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark':
        case 'URL':
        case 'LinkTitle':
        case 'LinkMark':
          hide(node.from, node.to);
          return false;
        case 'TaskMarker': {
          const line = doc.lineAt(node.from);
          const end = doc.sliceString(node.to, Math.min(node.to + 1, line.to)) === ' ' ? node.to + 1 : node.to;
          const label = line.text.slice(end - line.from).replace(/[*_~`[\]]/g, '').trim().slice(0, 120);
          const checked = /\[[xX]\]/.test(doc.sliceString(node.from, node.to));
          replace(node.from, end, new TaskWidget(node.from, checked, label, host));
          return false;
        }
        case 'StrongEmphasis':
        case 'Emphasis':
        case 'Strikethrough': {
          const first = node.node.firstChild;
          const last = node.node.lastChild;
          const markName = node.name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark';
          const mark = node.name === 'StrongEmphasis' ? strongMark : node.name === 'Emphasis' ? emphasisMark : strikeMark;
          if (first && last && first.name === markName && last.name === markName && last.from > first.to) ranges.push(mark.range(first.to, last.from));
          return true;
        }
        case 'InlineCode': {
          // The delimiters are `CodeMark` nodes of their own. Hiding their real edges and marking only the code
          // between them keeps a multi-backtick span intact and leaves no backtick outside the code element.
          const marks: { from: number; to: number }[] = [];
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'CodeMark') marks.push({ from: child.from, to: child.to });
          }
          const open = marks[0];
          const close = marks[marks.length - 1];
          if (open && close && marks.length > 1 && close.from > open.to) {
            hide(open.from, open.to);
            hide(close.from, close.to);
            ranges.push(codeMark.range(open.to, close.from));
          }
          return false;
        }
        case 'Autolink': {
          // `<https://…>` is a LinkMark/URL/LinkMark triple: only the angle brackets may disappear, the URL text
          // itself stays readable and keeps a safe action.
          const url = node.node.getChild('URL');
          const first = node.node.firstChild;
          const last = node.node.lastChild;
          if (first?.name === 'LinkMark') hide(first.from, first.to);
          if (last?.name === 'LinkMark' && last.from > (first?.from ?? -1)) hide(last.from, last.to);
          if (!url) return false;
          const href = host.autolinkHref(doc.sliceString(url.from, url.to));
          if (href) {
            ranges.push(Decoration.mark({
              tagName: 'a', class: 'cm-live-link',
              attributes: { href, target: '_blank', rel: 'noopener noreferrer', 'data-live-action': 'href' },
            }).range(url.from, url.to));
          }
          return false;
        }
        case 'Link': {
          const url = node.node.getChild('URL');
          if (!url) return false;
          const source = doc.sliceString(url.from, url.to);
          // `<…>` is Markdown syntax, not part of the target: both the href and the file action use its value.
          const target = markdownTarget(source);
          const fileId = privateFileId(source);
          const href = fileId ? target : host.safeHref(source);
          // Reference links without a resolvable target keep their literal source; guessing a URL is not allowed.
          if (!href) return false;
          const first = node.node.firstChild;
          if (first && first.name === 'LinkMark' && first.to < url.from - 1) {
            ranges.push(Decoration.mark(fileId
              ? { tagName: 'a', class: 'cm-live-link', attributes: { href, download: '', 'data-live-action': 'file', 'data-file-id': fileId } }
              : { tagName: 'a', class: 'cm-live-link', attributes: { href, target: '_blank', rel: 'noopener noreferrer', 'data-live-action': 'href' } },
            ).range(first.to, url.from - 1));
          }
          return true;
        }
        case 'HTMLTag':
        case 'HTMLBlock':
        case 'CommentBlock':
        case 'ProcessingInstructionBlock':
        case 'LinkReference':
          return false;
        case 'Image': {
          const url = node.node.getChild('URL');
          const id = url ? privateImageId(doc.sliceString(url.from, url.to)) : null;
          if (!id || !url) return false;
          const label = labelRange(node.node);
          const alt = doc.sliceString(label.from, label.to);
          replace(node.from, node.to,
            new InlineImageWidget(id, markdownTarget(doc.sliceString(url.from, url.to)), alt, node.from, node.to, host));
          return false;
        }
        default:
          return true;
      }
    },
  });
  for (const span of block.inline) {
    if (span.from < from || span.to > to) continue;
    if (span.kind === 'math') {
      // Inline math never spans a line break, so a span element is safe inside the line.
      replace(span.from, span.to, new MathWidget(span.tex ?? '', false, span.from, span.to, host));
    } else if (span.kind === 'wikilink' && span.noteId && span.label) {
      replace(span.from, span.to, new WikiLinkWidget(span.noteId, span.label, span.from));
    }
  }
}

function buildInlineDecorations(view: EditorView): { decorations: DecorationSet; atomic: DecorationSet } {
  const state = view.state;
  const value = state.field(livePreviewState, false);
  if (!value || state.facet(livePreviewMode) !== 'live' || !state.facet(livePreviewActive)) {
    return { decorations: Decoration.none, atomic: Decoration.none };
  }
  const host = state.facet(livePreviewHost);
  if (!host || !value.plan || value.plan.doc !== state.doc) return { decorations: Decoration.none, atomic: Decoration.none };
  const isActive = activeBlocks(state, value);
  const ranges: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const seen = new Set<LiveBlock>();
  for (const visible of view.visibleRanges) {
    for (const block of value.plan.blocks) {
      if (block.block || block.source || seen.has(block)) continue;
      if (block.to < visible.from || block.from > visible.to) continue;
      seen.add(block);
      if (isActive(block)) continue;
      inlineForBlock(state, block, state.doc.lineAt(Math.max(block.from, visible.from)).from, Math.min(block.to, visible.to), host, ranges, atomic);
    }
  }
  return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true) };
}

/**
 * A drag that starts on a rendered block records every block it enters or crosses, so a selection can span blocks
 * and always reads the real Markdown. The blocks stay source until the gesture ends, even when the pointer moves
 * back over one it already passed. The anchor and the crossed ranges belong to the document the gesture started
 * in, so the returned function abandons the gesture as soon as the text changes underneath it.
 */
function startWidgetDrag(
  view: EditorView, initial: { from: number; to: number }, finished: () => void,
): () => void {
  const anchor = view.state.selection.main.anchor;
  const crossed: { from: number; to: number }[] = [{ ...initial }];
  let head = anchor;
  const move = (event: MouseEvent) => {
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null || position === head) return;
    const from = Math.min(head, position);
    const to = Math.max(head, position);
    for (const block of planBlocks(view.state)) {
      if (block.to <= from || block.from >= to) continue;
      if (crossed.some((range) => range.from === block.from && range.to === block.to)) continue;
      crossed.push({ from: block.from, to: block.to });
    }
    head = position;
    view.dispatch({
      selection: { anchor, head: position },
      effects: exposeEffect.of(crossed),
      userEvent: 'select.pointer',
    });
  };
  const stop = () => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', finish, true);
    window.removeEventListener('keydown', escape, true);
  };
  const finish = () => {
    stop();
    finished();
    view.dispatch({ effects: exposeEffect.of(null) });
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    // Escape only abandons this gesture; the document is never touched.
    finish();
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', finish, true);
  window.addEventListener('keydown', escape, true);
  return stop;
}

/** One frame's worth of plan work; the whole plan may still take several frames. */
const PLAN_SLICE_MILLISECONDS = 8;

class LivePreviewController {
  decorations: DecorationSet = Decoration.none;
  atomic: DecorationSet = Decoration.none;
  private timer = 0;
  private frame = 0;
  private job: { doc: Text; iterator: Generator<void, LiveMarkdownPlan>; started: number } | null = null;
  private tree: ReturnType<typeof syntaxTree> | null = null;
  private reported: 'error' | 'budget' | 'size' | null = null;
  /** Owed work of the last plan; a plan that described less of it asks for the next chunk. */
  private owedSpan = 0;
  /** Abandons the pointer gesture in progress; its offsets belong to the document it started in. */
  private dragStop: (() => void) | null = null;

  constructor(readonly view: EditorView, private readonly options: () => LivePreviewOptions) {
    this.schedule(0);
  }

  private cancel() {
    if (this.timer) { window.clearTimeout(this.timer); this.timer = 0; }
    if (this.frame) { window.cancelAnimationFrame(this.frame); this.frame = 0; }
    this.job = null;
  }

  private schedule(delay: number) {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.start();
    }, delay);
  }

  private fail(reason: 'error' | 'budget' | 'size') {
    // One notice per failure kind: repeated keystrokes must not keep re-announcing the same degradation.
    if (this.reported === reason) return;
    this.reported = reason;
    this.options().onRenderFallback?.(reason);
  }

  private degrade(reason: 'error' | 'budget' | 'size') {
    this.cancel();
    // Never dispatch from inside a view update; the next task is safe.
    window.setTimeout(() => {
      if (!this.view.dom.isConnected) return;
      this.view.dispatch({ effects: setPlanEffect.of(null) });
      this.fail(reason);
    }, 0);
  }

  private start() {
    const state = this.view.state;
    if (state.facet(livePreviewMode) !== 'live' || !state.facet(livePreviewActive)) return;
    if (this.options().bytesOverLimit?.()) {
      this.cancel();
      this.view.dispatch({ effects: setPlanEffect.of(null) });
      this.fail('size');
      return;
    }
    // A fresh attempt may report again; the dedupe inside fail() only covers one plan run.
    this.reported = null;
    const value = state.field(livePreviewState, false);
    // The mapped plan still matches the document, so only the region this change reached has to be described.
    // A plan the parser could not finish reports the ranges it owes; they are described as the parse advances.
    const owed = value?.plan && value.plan.doc === state.doc
      ? (value.dirty.length ? value.dirty : value.plan.missing)
      : [];
    const seed = value?.plan && owed.length
      ? { plan: value.plan, dirty: owed, owed: value.dirty.length === 0 }
      : undefined;
    this.job = { doc: state.doc, iterator: analyzeLiveMarkdownSteps(state, seed), started: performance.now() };
    this.runSlice();
  }

  private runSlice() {
    const job = this.job;
    if (!job) return;
    if (this.view.state.doc !== job.doc) { this.cancel(); this.schedule(60); return; }
    const deadline = performance.now() + PLAN_SLICE_MILLISECONDS;
    let step: IteratorResult<void, LiveMarkdownPlan>;
    try {
      do { step = job.iterator.next(); } while (!step.done && performance.now() < deadline);
    } catch {
      this.degrade('error');
      return;
    }
    if (!step.done) {
      if (performance.now() - job.started > MAX_PLAN_MILLISECONDS) { this.degrade('budget'); return; }
      this.frame = window.requestAnimationFrame(() => {
        this.frame = 0;
        this.runSlice();
      });
      return;
    }
    this.job = null;
    const plan = step.value;
    if (plan.doc !== this.view.state.doc) return;
    this.tree = syntaxTree(this.view.state);
    if (plan.failure) {
      this.view.dispatch({ effects: setPlanEffect.of(null) });
      this.fail(plan.failure);
      return;
    }
    this.reported = null;
    this.view.dispatch({ effects: setPlanEffect.of(plan) });
    // A plan that still owes work asks for the next chunk as long as it made progress; a plan that described
    // nothing new waits for the parser instead of repeating itself. `owedSpan === 0` is the first plan after a
    // document change, where the owed work is only known now.
    const owed = plan.missing.reduce((total, range) => total + (range.to - range.from), 0);
    if (owed > 0 && (this.owedSpan === 0 || owed < this.owedSpan)) this.schedule(60);
    this.owedSpan = owed;
  }

  beginDrag(initial: { from: number; to: number }) {
    this.endDrag();
    this.dragStop = startWidgetDrag(this.view, initial, () => { this.dragStop = null; });
  }

  private endDrag(clearExposure = false) {
    const stop = this.dragStop;
    this.dragStop = null;
    stop?.();
    if (!clearExposure) return;
    // Dropping the exposed ranges is a view update of its own; the caller may be inside one.
    window.setTimeout(() => {
      if (this.view.dom.isConnected) this.view.dispatch({ effects: exposeEffect.of(null) });
    }, 0);
  }

  private refresh() {
    try {
      const built = buildInlineDecorations(this.view);
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    } catch {
      this.decorations = Decoration.none;
      this.atomic = Decoration.none;
      this.degrade('error');
    }
  }

  update(update: ViewUpdate) {
    if (decorationFailure) { decorationFailure = false; this.degrade('error'); }
    // A change from anywhere (the user, a draft restore, a remote sync) invalidates the gesture's anchor and
    // crossed ranges: it must not keep dispatching offsets that described the previous text.
    if (update.docChanged && this.dragStop) this.endDrag(true);
    const mode = update.state.facet(livePreviewMode);
    if (mode !== 'live' || !update.state.facet(livePreviewActive)) {
      this.cancel();
      this.decorations = Decoration.none;
      this.atomic = Decoration.none;
      this.reported = null;
      return;
    }
    const value = update.state.field(livePreviewState, false);
    const previous = update.startState.field(livePreviewState, false);
    // Source mode only maps the plan; its own edits accumulate in `dirty`. Returning to live has to describe
    // that region again, otherwise those blocks stay source and their widgets never come back.
    const wasLive = update.startState.facet(livePreviewMode) === 'live' &&
      update.startState.facet(livePreviewActive);
    if (update.docChanged) this.owedSpan = 0;
    if (value?.crashed) { this.decorations = Decoration.none; this.atomic = Decoration.none; this.degrade('error'); return; }
    if (update.docChanged || update.viewportChanged || update.selectionSet || previous !== value || !wasLive) this.refresh();
    const tree = syntaxTree(update.state);
    if (update.docChanged || !value?.plan || !wasLive || (tree !== this.tree && value.plan.missing.length > 0)) this.schedule(60);
  }

  destroy() { this.cancel(); this.endDrag(); }
}

function blockAt(state: EditorState, from: number): { from: number; to: number } {
  const block = planBlocks(state).find((item) => item.from === from);
  return block ? { from: block.from, to: block.to } : { from, to: from + 1 };
}

function planBlocks(state: EditorState): LiveBlock[] {
  const value = state.field(livePreviewState, false);
  if (!value?.plan || state.facet(livePreviewMode) !== 'live') return [];
  return value.plan.blocks;
}

function blockStartingAtLine(state: EditorState, lineNumber: number): LiveBlock | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null;
  const start = state.doc.line(lineNumber).from;
  return planBlocks(state).find((block) => block.block && block.from === start) ?? null;
}

function blockEndingAtLine(state: EditorState, lineNumber: number): LiveBlock | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null;
  const end = state.doc.line(lineNumber).to;
  return planBlocks(state).find((block) => block.block && block.to === end) ?? null;
}

function blockBefore(state: EditorState, head: number) {
  return planBlocks(state).find((block) => block.block && block.to <= head && !state.doc.sliceString(block.to, head).trim()) ?? null;
}

function blockAfter(state: EditorState, head: number) {
  return planBlocks(state).find((block) => block.block && block.from >= head && !state.doc.sliceString(head, block.from).trim()) ?? null;
}

function renderedReplacement(state: EditorState, block: LiveBlock | null): block is LiveBlock {
  const value = state.field(livePreviewState, false);
  if (!block || !value || !block.block || state.facet(livePreviewMode) !== 'live' || !state.facet(livePreviewActive)) return false;
  return !activeBlocks(state, value)(block);
}

// CodeMirror's own vertical motion usually lands on the boundary of a block widget, which exposes the block and
// keeps the source reachable. Only the cases where that motion would skip the replacement are handled: a wrapped
// paragraph keeps its own screen lines, an exposed block keeps the default keymap, and a jump that would leave
// the block behind is redirected to the block's first (downwards) or last (upwards) line.
const boundaryKeys = keymap.of([
  {
    key: 'ArrowDown', run: (view) => {
      const range = view.state.selection.main;
      if (!range.empty) return false;
      const line = view.state.doc.lineAt(range.head);
      const block = blockStartingAtLine(view.state, line.number + 1);
      if (!renderedReplacement(view.state, block)) return false;
      // The default motion stays on this line while it still has screen lines below the caret.
      const next = view.moveVertically(range, false);
      if (!next || view.state.doc.lineAt(next.head).number === line.number) return false;
      // The default already enters the block, which exposes it: nothing to redirect.
      if (next.head >= block.from && next.head <= block.to) return false;
      const first = view.state.doc.lineAt(block.from);
      view.dispatch({ selection: { anchor: Math.min(block.from + (range.head - line.from), first.to) }, scrollIntoView: true });
      return true;
    },
  },
  {
    key: 'ArrowUp', run: (view) => {
      const range = view.state.selection.main;
      if (!range.empty) return false;
      const line = view.state.doc.lineAt(range.head);
      const block = blockEndingAtLine(view.state, line.number - 1);
      if (!renderedReplacement(view.state, block)) return false;
      const next = view.moveVertically(range, true);
      if (!next || view.state.doc.lineAt(next.head).number === line.number) return false;
      if (next.head >= block.from && next.head <= block.to) return false;
      const last = view.state.doc.lineAt(block.to);
      view.dispatch({
        selection: { anchor: Math.max(last.from, Math.min(last.from + (range.head - line.from), last.to)) },
        scrollIntoView: true,
      });
      return true;
    },
  },
  {
    key: 'Backspace', run: (view) => {
      const range = view.state.selection.main;
      if (!range.empty) return false;
      const line = view.state.doc.lineAt(range.head);
      if (range.head !== line.from) return false;
      const block = blockBefore(view.state, line.from);
      if (!renderedReplacement(view.state, block)) return false;
      view.dispatch({ selection: { anchor: block.from }, scrollIntoView: true });
      return true;
    },
  },
  {
    key: 'Delete', run: (view) => {
      const range = view.state.selection.main;
      if (!range.empty) return false;
      const line = view.state.doc.lineAt(range.head);
      if (range.head !== line.to) return false;
      const block = blockAfter(view.state, line.to);
      if (!renderedReplacement(view.state, block)) return false;
      view.dispatch({ selection: { anchor: block.from }, scrollIntoView: true });
      return true;
    },
  },
]);

// CodeMirror only routes mousedown and a fixed set of DOM events, so widget actions are executed from a
// native click listener on the content DOM. That also covers Enter/Space activation of the same controls.
function runAction(event: MouseEvent, getOptions: () => LivePreviewOptions, view: EditorView): boolean {
  const target = event.target as HTMLElement | null;
  const action = target?.closest<HTMLElement>('[data-live-action]');
  if (!action) return false;
  switch (action.dataset.liveAction) {
    case 'note': {
      event.preventDefault();
      const id = action.dataset.noteId;
      if (id) getOptions().onNote(id);
      return true;
    }
    case 'file': {
      event.preventDefault();
      const id = action.dataset.fileId;
      if (id) getOptions().onFile(id, action.getAttribute('href') ?? '');
      return true;
    }
    case 'href': {
      event.preventDefault();
      const href = action.getAttribute('href');
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
      return true;
    }
    case 'image': {
      event.preventDefault();
      const id = action.dataset.imageId ?? '';
      const current = action.querySelector('img')?.src ?? action.dataset.imageSrc ?? '';
      if (!current.startsWith('blob:')) { getOptions().onImage(current); return true; }
      const resolve = getOptions().resolveFile?.();
      if (!resolve) { getOptions().onImage(current); return true; }
      // A widget-owned object URL dies with the widget, so the lightbox gets its own lease. A result that
      // arrives after the widget, the document, the mode or the view went away is released unused.
      const doc = view.state.doc;
      const from = Number(action.closest<HTMLElement>('[data-live-from]')?.dataset.liveFrom);
      const stale = () => !view.dom.isConnected || view.state.doc !== doc ||
        view.state.facet(livePreviewMode) !== 'live' || !view.state.facet(livePreviewActive) || !action.isConnected;
      const abandon = (url: string | null) => {
        if (url) URL.revokeObjectURL(url);
        if (!view.dom.isConnected || view.state.doc !== doc) return;
        if (Number.isInteger(from)) view.dispatch({ effects: exposeEffect.of([blockAt(view.state, from)]) });
        getOptions().onStatus?.(t('image_unavailable'));
      };
      void resolve(id).then((url) => {
        if (stale()) { abandon(url); return; }
        if (url) getOptions().onImage(url, () => URL.revokeObjectURL(url));
        else abandon(null);
      }).catch(() => abandon(null));
      return true;
    }
    default:
      return false;
  }
}

export function createLivePreview(getOptions: () => LivePreviewOptions): Extension {
  let currentView: EditorView | null = null;
  const safeHref = (source: string) => safeMarkdownHrefCached(source, getOptions().validateLink);
  const autolink = (source: string) => autolinkHrefCached(source, getOptions().validateLink);

  const host: LiveWidgetHost = {
    safeHref,
    autolinkHref: autolink,
    onTask(position, checked) {
      const view = currentView;
      if (!view) return;
      const doc = view.state.doc;
      if (!Number.isInteger(position) || position < 0 || position >= doc.length) return;
      // The checkbox shows one task, and its marker is the one at that exact offset: the write-back replaces that
      // marker itself instead of searching the line again, where another task could sit in front of it.
      const marker = /^\[[ xX]?\]/.exec(doc.sliceString(position, Math.min(doc.length, position + 3)));
      if (!marker) return;
      const to = position + marker[0].length;
      view.dispatch({
        changes: { from: position, to, insert: checked ? '[x]' : '[ ]' },
        annotations: isolateHistory.of('full'),
        userEvent: 'input',
      });
    },
    sourceLine(position) {
      const doc = currentView?.state.doc;
      if (!doc || !Number.isInteger(position) || position < 0 || position > doc.length) return null;
      return doc.lineAt(position).number - 1;
    },
    onImage: (src, release) => getOptions().onImage(src, release),
    onNote: (id) => getOptions().onNote(id),
    onFile: (id, href) => getOptions().onFile(id, href),
    resolveFile: (id: string) => getOptions().resolveFile?.()?.(id) ?? Promise.resolve(null),
    expose(from, to) {
      currentView?.dispatch({ effects: exposeEffect.of([{ from, to }]) });
    },
    notify: (message) => getOptions().onStatus?.(message),
    requestMeasure: () => currentView?.requestMeasure(),
    fold(from, key, identity, open) {
      const value = currentView?.state.field(livePreviewState, false);
      const block = value?.plan?.blocks.find((item) => item.from === from);
      if (!block) return;
      currentView?.dispatch({ effects: foldEffect.of({ from: block.from, to: block.to, key, identity, open }) });
    },
    folded(from, key, identity, fallback) {
      const value = currentView?.state.field(livePreviewState, false);
      const block = value?.plan?.blocks.find((item) => item.from === from);
      if (!value || !block) return fallback;
      return foldedValue(value.folding, block.from, block.to, key, identity) ?? fallback;
    },
  };
  const controller = ViewPlugin.fromClass(class extends LivePreviewController {
    private readonly onNativeClick = (event: MouseEvent) => { runAction(event, getOptions, this.view); };
    constructor(view: EditorView) {
      super(view, getOptions);
      currentView = view;
      view.contentDOM.addEventListener('click', this.onNativeClick);
    }
    destroy() {
      this.view.contentDOM.removeEventListener('click', this.onNativeClick);
      currentView = null;
      super.destroy();
    }
  }, {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target as HTMLElement | null;
        if (!target) return false;
        const action = target.closest<HTMLElement>('[data-live-action]');
        if (action) {
          // Widget controls keep their own click/keyboard behaviour instead of moving the caret; the action
          // itself runs from the native click listener so a drag that leaves the control cancels it.
          event.preventDefault();
          return true;
        }
        if (target.closest('summary')) {
          // The collapsible header keeps its native toggle instead of exposing the whole block.
          event.preventDefault();
          return true;
        }
        const widget = target.closest<HTMLElement>('[data-live-from]');
        if (!widget) return false;
        const from = Number(widget.dataset.liveFrom);
        if (!Number.isInteger(from)) return false;
        // Pressing anywhere on a rendered block puts the caret at its first source position and exposes it, then
        // the gesture keeps extending a source selection (see startWidgetDrag) instead of being cancelled.
        const block = blockAt(view.state, from);
        view.dispatch({ selection: { anchor: block.from }, effects: exposeEffect.of([block]) });
        view.focus();
        event.preventDefault();
        this.beginDrag(block);
        return true;
      },
      compositionstart(_event, view) {
        const value = view.state.field(livePreviewState, false);
        const head = view.state.selection.main.head;
        const block = value?.plan?.blocks.find((item) => head >= item.from && head <= item.to);
        if (!block) return;
        const effect = exposeEffect.of([{ from: block.from, to: block.to }]);
        window.setTimeout(() => view.dispatch({ effects: effect }), 0);
      },
      compositionend(_event, view) {
        // Wait for the final input event and the DOM flush; `view.composing` is the authority, not the event.
        const settle = () => {
          if (view.composing) { window.requestAnimationFrame(settle); return; }
          view.dispatch({ effects: exposeEffect.of(null) });
        };
        window.requestAnimationFrame(settle);
      },
    },
  });

  return [
    livePreviewHost.of(host),
    livePreviewState,
    blockDecorations,
    controller,
    EditorView.atomicRanges.of((view) => view.plugin(controller)?.atomic ?? Decoration.none),
    Prec.high(boundaryKeys),
  ];
}

const hrefCache = new WeakMap<(source: string) => boolean, Map<string, string | null>>();
function safeMarkdownHrefCached(source: string, validate: (source: string) => boolean): string | null {
  let entries = hrefCache.get(validate);
  if (!entries) { entries = new Map(); hrefCache.set(validate, entries); }
  if (entries.has(source)) return entries.get(source)!;
  const value = safeMarkdownHref(source, validate);
  if (entries.size > 2000) entries.clear();
  entries.set(source, value);
  return value;
}

const autolinkCache = new WeakMap<(source: string) => boolean, Map<string, string | null>>();
function autolinkHrefCached(source: string, validate: (source: string) => boolean): string | null {
  let entries = autolinkCache.get(validate);
  if (!entries) { entries = new Map(); autolinkCache.set(validate, entries); }
  if (entries.has(source)) return entries.get(source)!;
  const value = autolinkHref(source, validate);
  if (entries.size > 2000) entries.clear();
  entries.set(source, value);
  return value;
}
