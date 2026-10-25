import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, redo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Table, TaskList, Strikethrough } from '@lezer/markdown';
import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { markdownMath } from './math';
import DOMPurify from 'dompurify';
import { idPattern } from '../shared/types';
import { t } from './i18n';
import { downloadDiagram, type DiagramImageFormat } from './diagramExport';
import { searchHighlights, searchQueryFacet } from './editorSearch';
import { externalChanges } from './textDiff';
import { createLivePreview, livePreviewActive, livePreviewMode } from './livePreview';
import { privateFileId, privateImageId } from './markdownResources';

export { toggleMarkdownTask } from './markdownResources';

export interface EditorViewportAnchor {
  offset: number;
  top: number;
}

interface Props {
  value: string;
  mode: 'source' | 'live';
  /** False while reading mode hides the editor; the instance stays mounted to keep history, selection and markers. */
  active: boolean;
  maxNoteBytes: number;
  onChange(value: string): void;
  onImages(files: File[], insertion: string): void;
  onToggleReading(): void;
  onShowShortcuts(): void;
  searchQuery?: string;
  onImage(src: string, release?: () => void): void;
  onNote(id: string): void;
  onFile(id: string, href: string): void;
  resolveFile?(id: string): Promise<string | null>;
  onRenderFallback?(reason: 'error' | 'size' | 'budget'): void;
}

export interface EditorHandle {
  markInsertion(): string;
  insertAt(insertion: string, value: string): boolean;
  releaseInsertion(insertion: string): void;
  cursor(): number;
  goTo(offset: number): void;
  focus(): void;
  captureViewport(): EditorViewportAnchor | null;
  restoreViewport(anchor: EditorViewportAnchor): void;
}

function toggleEmphasis(marker: '*' | '**') {
  return (editor: EditorView): boolean => {
    const range = editor.state.selection.main;
    if (range.empty) {
      editor.dispatch({
        changes: { from: range.from, insert: `${marker}${marker}` },
        selection: { anchor: range.from + marker.length },
        scrollIntoView: true,
      });
      return true;
    }
    const document = editor.state.doc;
    let before = 0;
    let after = 0;
    while (range.from - before > 0 && document.sliceString(range.from - before - 1, range.from - before) === '*') before++;
    while (range.to + after < document.length && document.sliceString(range.to + after, range.to + after + 1) === '*') after++;
    const active = marker === '*' ? before % 2 === 1 && after % 2 === 1 : before >= 2 && after >= 2;
    if (active) {
      editor.dispatch({
        changes: [
          { from: range.from - marker.length, to: range.from },
          { from: range.to, to: range.to + marker.length },
        ],
        selection: { anchor: range.from - marker.length, head: range.to - marker.length },
        scrollIntoView: true,
      });
    } else {
      editor.dispatch({
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        selection: { anchor: range.from + marker.length, head: range.to + marker.length },
        scrollIntoView: true,
      });
    }
    return true;
  };
}

// The live surface adds only the GFM constructs the reading renderer already understands; markdownLanguage's
// subscript, superscript and emoji are deliberately not enabled.
const liveMarkdown = () => markdown({ extensions: [Table, TaskList, Strikethrough] });
const sourceMarkdown = () => markdown();

const encoder = new TextEncoder();

export const Editor = forwardRef<EditorHandle, Props>(function Editor({
  value,
  mode,
  active,
  maxNoteBytes,
  onChange,
  onImages,
  onToggleReading,
  onShowShortcuts,
  searchQuery = '',
  onImage,
  onNote,
  onFile,
  resolveFile,
  onRenderFallback,
}, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const search = useRef(new Compartment());
  const config = useRef(new Compartment());
  const language = useRef(new Compartment());
  const callbacks = useRef({ onChange, onImages, onToggleReading, onShowShortcuts, onImage, onNote, onFile, resolveFile, onRenderFallback, maxNoteBytes });
  const insertions = useRef(new Map<string, number>());
  callbacks.current = { onChange, onImages, onToggleReading, onShowShortcuts, onImage, onNote, onFile, resolveFile, onRenderFallback, maxNoteBytes };
  const external = useRef(false);
  const bytes = useRef(encoder.encode(value).length);
  const oversized = useRef(bytes.current > maxNoteBytes);
  const statusTimer = useRef(0);
  const pendingConfig = useRef<{ mode: 'source' | 'live'; active: boolean } | null>(null);

  const notify = (message: string) => {
    const element = status.current;
    if (!element) return;
    element.textContent = message;
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => { if (status.current) status.current.textContent = ''; }, 6000);
  };

  // One stable validator identity keeps the live-preview href cache effective and pins the decision to the
  // same MarkdownIt instance the reading surface uses.
  const validateLink = useRef((href: string) => renderer.validateLink(href)).current;
  const live = useMemo(() => createLivePreview(() => ({
    validateLink,
    onImage: (src, release) => callbacks.current.onImage(src, release),
    onNote: (id) => callbacks.current.onNote(id),
    onFile: (id, href) => callbacks.current.onFile(id, href),
    resolveFile: () => callbacks.current.resolveFile,
    onRenderFallback: (reason) => callbacks.current.onRenderFallback?.(reason),
    onStatus: notify,
    bytesOverLimit: () => bytes.current > callbacks.current.maxNoteBytes,
  })), []);

  // Rendering an oversized draft must degrade in every entry path: first load, mode change and a lowered limit.
  const reportOversized = () => {
    const over = bytes.current > callbacks.current.maxNoteBytes;
    oversized.current = over;
    if (over) callbacks.current.onRenderFallback?.('size');
    return over;
  };

  const applyConfig = (editor: EditorView, nextMode: 'source' | 'live', nextActive: boolean) => {
    editor.dispatch({
      effects: [
        config.current.reconfigure([
          livePreviewMode.of(nextMode), livePreviewActive.of(nextActive),
          EditorView.editable.of(nextActive), EditorState.readOnly.of(!nextActive),
        ]),
        language.current.reconfigure(nextMode === 'live' ? liveMarkdown() : sourceMarkdown()),
      ],
    });
    if (nextActive) editor.requestMeasure();
  };

  const markInsertion = (position?: number) => {
    const id = crypto.randomUUID();
    insertions.current.set(id, position ?? view.current?.state.selection.main.head ?? 0);
    return id;
  };

  useImperativeHandle(ref, () => ({
    markInsertion,
    insertAt(insertion, text) {
      const editor = view.current;
      const marked = insertions.current.get(insertion);
      if (!editor || marked === undefined) return false;
      const position = Math.min(marked, editor.state.doc.length);
      const before = position > 0 && editor.state.doc.sliceString(position - 1, position) !== '\n' ? '\n\n' : '';
      const after = position < editor.state.doc.length && editor.state.doc.sliceString(position, position + 1) !== '\n' ? '\n\n' : '\n';
      const inserted = `${before}${text}${after}`;
      editor.dispatch({
        changes: { from: position, insert: inserted },
        selection: { anchor: position + inserted.length },
        scrollIntoView: true,
      });
      insertions.current.set(insertion, position + inserted.length);
      editor.focus();
      return true;
    },
    releaseInsertion(insertion) { insertions.current.delete(insertion); },
    cursor() { return view.current?.state.selection.main.head ?? 0; },
    goTo(offset) {
      const editor = view.current;
      if (!editor) return;
      const position = Math.max(0, Math.min(offset, editor.state.doc.length));
      editor.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      editor.focus();
    },
    focus() { view.current?.focus(); },
    captureViewport() {
      const editor = view.current;
      if (!editor) return null;
      const scroller = document.querySelector<HTMLElement>('.document-scroll');
      if (!scroller) return null;
      // The anchor is the source line visible at the top of the editor viewport, not the caret: the user may
      // have scrolled away from the caret before switching modes.
      const containerTop = scroller.getBoundingClientRect().top;
      const block = editor.lineBlockAtHeight(containerTop - editor.documentTop);
      const coords = editor.coordsAtPos(block.from);
      return { offset: block.from, top: (coords?.top ?? block.top + editor.documentTop) - containerTop };
    },
    restoreViewport(anchor) {
      const editor = view.current;
      const scroller = document.querySelector<HTMLElement>('.document-scroll');
      if (!editor || !scroller) return;
      editor.requestMeasure();
      const offset = Math.max(0, Math.min(anchor.offset, editor.state.doc.length));
      const coords = editor.coordsAtPos(offset);
      const top = coords?.top ?? editor.lineBlockAt(offset).top + editor.documentTop;
      scroller.scrollTop += top - scroller.getBoundingClientRect().top - anchor.top;
    },
  }), []);

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          config.current.of([
            livePreviewMode.of(mode), livePreviewActive.of(active),
            EditorView.editable.of(active), EditorState.readOnly.of(!active),
          ]),
          language.current.of(mode === 'live' ? liveMarkdown() : sourceMarkdown()),
          live,
          history(), keymap.of([
            { key: 'Mod-b', run: toggleEmphasis('**') },
            { key: 'Mod-i', run: toggleEmphasis('*') },
            { key: 'Mod-Shift-z', run: redo, preventDefault: true },
            { key: 'Ctrl-e', run: () => { callbacks.current.onToggleReading(); return true; } },
            { key: 'Meta-e', run: () => { callbacks.current.onToggleReading(); return true; } },
            { key: 'Mod-/', run: () => { callbacks.current.onShowShortcuts(); return true; } },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.lineWrapping, placeholder(t('start_writing')),
          search.current.of(searchQueryFacet.of(searchQuery)),
          searchHighlights,
          EditorView.contentAttributes.of({
            'aria-label': t('note_content'),
            'aria-keyshortcuts': 'Meta+B Control+B Meta+I Control+I Meta+E Control+E Meta+/ Control+/',
            spellcheck: 'false',
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              for (const [id, position] of insertions.current) {
                insertions.current.set(id, update.changes.mapPos(position, -1));
              }
              update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
                bytes.current += encoder.encode(update.state.doc.sliceString(fromB, toB)).length
                  - encoder.encode(update.startState.doc.sliceString(fromA, toA)).length;
              });
              const nowOversized = bytes.current > callbacks.current.maxNoteBytes;
              if (nowOversized && !oversized.current) callbacks.current.onRenderFallback?.('size');
              oversized.current = nowOversized;
            }
            if (update.docChanged && !external.current) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(event) {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (!files.length) return false;
              event.preventDefault();
              callbacks.current.onImages(files, markInsertion());
              return true;
            },
            drop(event, editorView) {
              const files = Array.from(event.dataTransfer?.files ?? []);
              if (!files.length) return false;
              event.preventDefault();
              callbacks.current.onImages(files, markInsertion(editorView.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined));
              return true;
            },
            dragover(event) { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); },
          }),
        ],
      }),
    });
    view.current = editor;
    const flushPendingConfig = () => {
      window.requestAnimationFrame(() => {
        const pending = pendingConfig.current;
        const current = view.current;
        if (!pending || !current) return;
        if (current.composing) { flushPendingConfig(); return; }
        pendingConfig.current = null;
        applyConfig(current, pending.mode, pending.active);
      });
    };
    editor.contentDOM.addEventListener('compositionend', flushPendingConfig);
    if (mode === 'live' && active) reportOversized();
    return () => {
      window.clearTimeout(statusTimer.current);
      editor.contentDOM.removeEventListener('compositionend', flushPendingConfig);
      editor.destroy();
      view.current = null;
      insertions.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    // A mode change during an active composition would rebuild the content DOM under the IME; the request is
    // queued and applied after the composition commits.
    if (editor.composing) { pendingConfig.current = { mode, active }; return; }
    applyConfig(editor, mode, active);
    if (mode === 'live' && active) reportOversized();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, active]);

  useEffect(() => {
    if (mode === 'live' && active) reportOversized();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxNoteBytes]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    const changes = externalChanges(current, value);
    if (!changes.length) return;
    // Several bounded regions instead of one span keep the selection and insertion markers of the untouched
    // middle of the note where they are (see textDiff for the size limit of this guarantee).
    external.current = true;
    editor.dispatch({ changes });
    external.current = false;
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({ effects: search.current.reconfigure(searchQueryFacet.of(searchQuery)) });
  }, [searchQuery]);
  return <>
    <div className="code-editor" ref={host} hidden={!active} aria-hidden={!active || undefined} />
    <div className="editor-status" role="status" aria-live="polite" ref={status} />
  </>;
});

const renderer = new MarkdownIt({ html: true, linkify: true, breaks: true }).use(footnote).use(markdownMath);
renderer.core.ruler.after('block', 'source_lines', (state) => {
  for (const [index, token] of state.tokens.entries()) {
    if (token.map && token.nesting === 1) token.attrSet('data-source-line', String(token.map[0]));
    const inline = state.tokens[index + 2];
    if (token.type === 'list_item_open' && inline?.type === 'inline' && inline.map &&
        /^\[([ xX]?)\](?=\s|$)/.test(inline.content)) {
      token.attrSet('data-task-line', String(inline.map[0]));
    }
  }
});
const defaultText = renderer.renderer.rules.text;
renderer.renderer.rules.text = (tokens, index, options, env, self) => {
  const rendered = defaultText
    ? defaultText(tokens, index, options, env, self)
    : renderer.utils.escapeHtml(tokens[index].content);
  return rendered.replace(/\[\[([0-9a-f-]{36})\|([^\]\r\n]{1,256})\]\]/gi, (source, id: string, label: string) =>
    idPattern.test(id) ? `<a href="#note-${id}" data-note-id="${id}">${label}</a>` : source);
};
renderer.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token.info.trim().split(/\s+/, 1)[0].toLowerCase();
  const sourceLine = token.map ? ` data-source-line="${token.map[0]}"` : '';
  const source = renderer.utils.escapeHtml(token.content);
  if (language === 'mermaid') {
    return `<div data-mermaid-source="true"${sourceLine}><pre><code>${source}</code></pre></div>`;
  }
  return `<pre${sourceLine}><code data-code-language="${renderer.utils.escapeHtml(language)}">${source}</code></pre>\n`;
};
renderer.renderer.rules.code_block = (tokens, index) => {
  const token = tokens[index];
  const sourceLine = token.map ? ` data-source-line="${token.map[0]}"` : '';
  return `<pre${sourceLine}><code data-code-language="">${renderer.utils.escapeHtml(token.content)}</code></pre>\n`;
};
renderer.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const src = token.attrGet('src') ?? '';
  const id = privateImageId(src);
  if (!id) return `<span class="blocked-image">${t('[外部图片未加载]')}</span>`;
  return `<img src="${src}" data-private-image="${id}" alt="${renderer.utils.escapeHtml(token.content)}" loading="lazy" />`;
};
renderer.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const href = tokens[index].attrGet('href') ?? '';
  const id = privateFileId(href);
  if (id) {
    tokens[index].attrSet('data-private-file', id);
    tokens[index].attrSet('download', '');
  } else {
    tokens[index].attrSet('target', '_blank');
    tokens[index].attrSet('rel', 'noopener noreferrer');
  }
  return self.renderToken(tokens, index, options);
};
renderer.renderer.rules.footnote_ref = (tokens, index) => {
  const number = Number(tokens[index].meta.id) + 1;
  const subId = Number(tokens[index].meta.subId ?? 0);
  const reference = subId > 0 ? `${number}:${subId}` : String(number);
  return `<sup><a href="#footnote-${number}" data-footnote-ref="${number}" data-footnote-reference="${reference}">[${reference}]</a></sup>`;
};
renderer.renderer.rules.footnote_block_open = () =>
  '<hr data-footnotes-separator>\n<section data-footnotes>\n<ol>\n';
renderer.renderer.rules.footnote_block_close = () => '</ol>\n</section>\n';
renderer.renderer.rules.footnote_open = (tokens, index) => {
  const number = Number(tokens[index].meta.id) + 1;
  return `<li data-footnote-id="${number}">`;
};
renderer.renderer.rules.footnote_close = () => '</li>\n';
renderer.renderer.rules.footnote_anchor = (tokens, index) => {
  const number = Number(tokens[index].meta.id) + 1;
  const subId = Number(tokens[index].meta.subId ?? 0);
  const reference = subId > 0 ? `${number}:${subId}` : String(number);
  return ` <a href="#footnote-ref-${reference}" data-footnote-backref="${reference}" aria-label="${t('返回脚注引用')}">↩︎</a>`;
};

function highlightRenderedText(root: HTMLElement, query: string) {
  const needle = query.trim();
  if (!needle) return;
  const normalizedNeedle = needle.toLocaleLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const matches: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = current as Text;
    if (text.parentElement && !text.parentElement.closest('svg, [data-math-display], .search-highlight') &&
        text.data.toLocaleLowerCase().includes(normalizedNeedle)) matches.push(text);
    current = walker.nextNode();
  }
  for (const text of matches) {
    const haystack = text.data.toLocaleLowerCase();
    const fragment = document.createDocumentFragment();
    let offset = 0;
    let match = haystack.indexOf(normalizedNeedle);
    while (match >= 0) {
      if (match > offset) fragment.append(text.data.slice(offset, match));
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = text.data.slice(match, match + needle.length);
      fragment.append(mark);
      offset = match + needle.length;
      match = haystack.indexOf(normalizedNeedle, offset);
    }
    if (offset < text.data.length) fragment.append(text.data.slice(offset));
    text.replaceWith(fragment);
  }
}

const tocMarker = /^\[toc\]$/i;

function contentHeadings(parsed: Document): HTMLElement[] {
  return [...parsed.body.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]
    .filter((heading) => !heading.closest('blockquote, [data-footnotes]'))
    .filter((heading) => (heading.textContent ?? '').trim());
}

function buildContents(parsed: Document, headings: HTMLElement[]): HTMLElement {
  const nav = parsed.createElement('nav');
  nav.className = 'note-toc';
  nav.setAttribute('aria-label', t('note_contents'));
  const title = parsed.createElement('p');
  title.className = 'note-toc-title';
  title.textContent = t('note_contents');
  nav.appendChild(title);
  if (!headings.length) {
    const empty = parsed.createElement('p');
    empty.className = 'note-toc-empty';
    empty.textContent = t('no_headings');
    nav.appendChild(empty);
    return nav;
  }
  const list = parsed.createElement('ol');
  list.className = 'note-toc-list';
  nav.appendChild(list);
  const levels: { level: number; list: HTMLOListElement; item: HTMLLIElement | null }[] = [];
  headings.forEach((heading, index) => {
    const level = Number(heading.tagName.slice(1));
    while (levels.length && level <= levels[levels.length - 1].level) levels.pop();
    if (!levels.length) levels.push({ level, list, item: null });
    else if (level > levels[levels.length - 1].level) {
      const parent = levels[levels.length - 1].item!;
      // Reuse the trailing sub-list so a skipped heading level does not restart numbering.
      const nested = (parent.lastElementChild?.tagName === 'OL'
        ? parent.lastElementChild
        : parent.appendChild(parsed.createElement('ol'))) as HTMLOListElement;
      nested.className = 'note-toc-list';
      levels.push({ level, list: nested, item: null });
    }
    const item = parsed.createElement('li');
    const link = parsed.createElement('a');
    link.setAttribute('href', '#');
    link.setAttribute('data-toc-target', String(index));
    link.textContent = heading.textContent!.trim();
    item.appendChild(link);
    levels[levels.length - 1].list.appendChild(item);
    levels[levels.length - 1].item = item;
  });
  return nav;
}

function insertContents(parsed: Document) {
  const markers = [...parsed.body.querySelectorAll('p')].filter((paragraph) =>
    paragraph.parentElement === parsed.body &&
    paragraph.childNodes.length === 1 &&
    paragraph.firstChild?.nodeType === Node.TEXT_NODE &&
    tocMarker.test(paragraph.textContent?.trim() ?? ''));
  if (!markers.length) return;
  const headings = contentHeadings(parsed);
  headings.forEach((heading, index) => heading.setAttribute('data-toc-heading', String(index)));
  const contents = buildContents(parsed, headings);
  for (const marker of markers) {
    const nav = contents.cloneNode(true) as HTMLElement;
    const sourceLine = (marker as HTMLElement).dataset.sourceLine;
    if (sourceLine) nav.dataset.sourceLine = sourceLine;
    marker.replaceWith(nav);
  }
}

function renderMarkdown(content: string, interactiveTasks: boolean, searchQuery: string): string {
  const clean = DOMPurify.sanitize(renderer.render(content), {
    USE_PROFILES: { html: true },
    ADD_ATTR: [
      'target', 'download', 'data-source-line', 'data-task-line', 'data-code-language', 'data-mermaid-source', 'data-math-display',
      'data-note-id', 'data-private-image', 'data-private-file', 'data-footnotes',
      'data-footnotes-separator', 'data-footnote-id', 'data-footnote-ref',
      'data-footnote-reference', 'data-footnote-backref',
    ],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: [
      'style', 'script', 'iframe', 'form', 'input', 'button', 'select', 'option', 'textarea',
      'object', 'embed', 'link', 'meta', 'base', 'video', 'audio', 'source', 'track',
    ],
    FORBID_ATTR: ['style', 'srcset', 'id', 'name', 'class'],
  });
  const parsed = new DOMParser().parseFromString(clean, 'text/html');
  parsed.body.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src') ?? '';
    const id = privateImageId(src);
    if (id) {
      image.setAttribute('loading', 'lazy');
      image.setAttribute('data-private-image', id);
      return;
    }
    const replacement = parsed.createElement('span');
    replacement.className = 'blocked-image';
    replacement.textContent = t('[外部图片未加载]');
    image.replaceWith(replacement);
  });
  parsed.body.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
    if (link.dataset.footnoteRef || link.dataset.footnoteBackref) {
      link.removeAttribute('target');
      link.removeAttribute('rel');
      return;
    }
    const noteId = link.dataset.noteId;
    if (noteId && idPattern.test(noteId)) {
      link.href = `#note-${noteId}`;
      link.removeAttribute('target');
      link.removeAttribute('rel');
      return;
    }
    const fileId = privateFileId(link.getAttribute('href') ?? '');
    if (fileId) {
      link.dataset.privateFile = fileId;
      link.setAttribute('download', '');
      link.removeAttribute('target');
      link.removeAttribute('rel');
      return;
    }
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  });
  parsed.body.querySelectorAll<HTMLLIElement>('li').forEach((item) => {
    const holder = item.firstElementChild?.tagName === 'P' ? item.firstElementChild : item;
    const text = holder.firstChild?.nodeType === Node.TEXT_NODE ? holder.firstChild : null;
    const match = /^(\s*)\[([ xX]?)\](?:\s+|$)/.exec(text?.textContent ?? '');
    const sourceLine = Number(item.dataset.taskLine);
    if (!text || !match || !Number.isInteger(sourceLine) || sourceLine < 0) return;
    const checked = match[2].toLocaleLowerCase() === 'x';
    text.textContent = `${match[1]}${text.textContent!.slice(match[0].length)}`;
    const checkbox = parsed.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.taskLine = String(sourceLine);
    checkbox.setAttribute('aria-label', t('待办事项：{0}', item.textContent?.trim() || t('未命名')));
    if (checked) {
      checkbox.checked = true;
      checkbox.setAttribute('checked', '');
      item.classList.add('done');
    }
    if (!interactiveTasks) checkbox.disabled = true;
    item.classList.add('task-list-item');
    item.parentElement?.classList.add('task-list');
    holder.insertBefore(checkbox, holder.firstChild);
  });
  insertContents(parsed);
  highlightRenderedText(parsed.body, searchQuery);
  return parsed.body.innerHTML;
}

function diagramError(element: HTMLElement, error: unknown) {
  element.className = 'mermaid-error';
  element.removeAttribute('data-mermaid-source');
  element.textContent = t('图表无法渲染：{0}', String(error).split('\n', 1)[0]);
}

function addDiagramExportActions(element: HTMLElement) {
  const svg = element.querySelector<SVGSVGElement>('svg');
  if (!svg) return;
  const visual = document.createElement('div');
  visual.className = 'diagram-visual';
  svg.replaceWith(visual);
  visual.appendChild(svg);
  const actions = document.createElement('div');
  actions.className = 'diagram-export-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', t('图表操作'));
  for (const format of ['svg', 'png'] as DiagramImageFormat[]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'diagram-export-button';
    button.dataset.diagramExport = format;
    button.textContent = format.toLocaleUpperCase();
    button.title = t('将图表另存为 {0}', format.toLocaleUpperCase());
    button.setAttribute('aria-label', button.title);
    actions.appendChild(button);
  }
  visual.appendChild(actions);
}

export function Preview({
  content,
  name = '',
  onImage,
  onNote,
  onFile,
  onTask,
  resolveFile,
  eagerImages = false,
  onEditLine,
  searchQuery = '',
}: {
  content: string;
  name?: string;
  onImage(src: string): void;
  onNote?(id: string): void;
  onFile?(id: string, href: string): void;
  onTask?(sourceLine: number, checked: boolean): void;
  resolveFile?(id: string): Promise<string | null>;
  eagerImages?: boolean;
  onEditLine?(line: number): void;
  searchQuery?: string;
}) {
  const host = useRef<HTMLElement>(null);
  const html = useMemo(() => renderMarkdown(content, !!onTask, searchQuery), [content, !!onTask, searchQuery]);
  useEffect(() => {
    const elements = [...(host.current?.querySelectorAll<HTMLElement>('[data-mermaid-source]') ?? [])];
    const formulas = [...(host.current?.querySelectorAll<HTMLElement>('[data-math-display]') ?? [])];
    const codeBlocks = [...(host.current?.querySelectorAll<HTMLElement>('code[data-code-language]') ?? [])];
    const privateImages = [...(host.current?.querySelectorAll<HTMLImageElement>('img[data-private-image]') ?? [])];
    const objectUrls: string[] = [];
    let cancelled = false;
    if (eagerImages) privateImages.forEach((image) => { image.loading = 'eager'; });
    if (resolveFile) {
      for (const image of privateImages) {
        const id = image.dataset.privateImage;
        if (!id) continue;
        let attempted = false;
        const useCached = () => {
          if (attempted) return;
          attempted = true;
          void resolveFile(id).then((url) => {
            if (!url) return;
            if (cancelled) URL.revokeObjectURL(url);
            else { objectUrls.push(url); image.src = url; }
          });
        };
        image.addEventListener('error', useCached, { once: true });
        if (image.complete && image.naturalWidth === 0) useCached();
      }
    }
    if (formulas.length) void (async () => {
      try {
        const { default: katex } = await import('katex');
        if (cancelled) return;
        for (const element of formulas) {
          const source = element.textContent ?? '';
          const display = element.dataset.mathDisplay === 'true';
          element.className = display ? 'math-formula math-display' : 'math-formula';
          try {
            if (source.length > 10_000) throw new Error('Formula exceeds 10,000 characters.');
            element.innerHTML = katex.renderToString(source, {
              displayMode: display, output: 'mathml', trust: false,
              throwOnError: true, maxExpand: 1000, maxSize: 20,
            });
          } catch (error) {
            element.classList.add('math-error');
            element.textContent = source;
            element.title = String(error);
          }
          element.removeAttribute('data-math-display');
        }
      } catch (error) {
        if (!cancelled) for (const element of formulas) {
          element.title = String(error);
          element.removeAttribute('data-math-display');
        }
      }
    })();
    if (codeBlocks.some((code) => code.dataset.codeLanguage)) void (async () => {
      const { default: highlighter } = await import('highlight.js/lib/common');
      if (cancelled) return;
      for (const code of codeBlocks) {
        const language = code.dataset.codeLanguage ?? '';
        if (!language || !highlighter.getLanguage(language)) continue;
        try {
          code.innerHTML = highlighter.highlight(code.textContent ?? '', { language, ignoreIllegals: true }).value;
          code.classList.add('hljs');
        } catch { /* Keep escaped plain text when a language cannot be highlighted. */ }
      }
    })();
    if (elements.length) void (async () => {
      try {
        const { render } = await import('pele');
        for (const [index, element] of elements.entries()) {
          if (cancelled) return;
          const source = element.textContent?.trim() ?? '';
          if (!source || source.length > 50_000 || index >= 20) {
            diagramError(element, source ? t('图表内容过大或数量超过 20 个。') : t('图表内容为空。'));
            continue;
          }
          try {
            const { svg } = render(source, {
              // Unique per diagram: pele derives the <title>/<desc> ids and their
              // aria-labelledby/aria-describedby references from this prefix.
              idPrefix: `easynote-diagram-${crypto.randomUUID()}`,
              fontSize: 14,
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              links: false,
              images: false,
              limit: 50_000,
              maxEdges: 500,
            });
            if (cancelled) return;
            // Pele emits no <style> element: the theme rides on CSS variables in the root
            // <svg> style attribute, so the sanitizer only needs to keep its role attribute.
            element.innerHTML = DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
              ADD_ATTR: ['role'],
            });
            element.className = 'mermaid-diagram';
            element.removeAttribute('data-mermaid-source');
            addDiagramExportActions(element);
          } catch (error) {
            diagramError(element, error);
          }
        }
      } catch (error) {
        if (!cancelled) elements.forEach((element) => diagramError(element, error));
      }
    })();
    return () => {
      cancelled = true;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
    // Pele reads the theme from CSS variables, so a theme switch needs no re-render.
  }, [html, resolveFile, eagerImages]);

  return <article ref={host} className="markdown" onDoubleClick={(event) => {
    if (!onEditLine) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, img, summary')) return;
    const block = target.closest<HTMLElement>('[data-source-line]');
    const line = Number(block?.dataset.sourceLine);
    if (Number.isInteger(line) && line >= 0) onEditLine(line);
  }} onClick={(event) => {
    const target = event.target as HTMLElement;
    const exportButton = target.closest<HTMLButtonElement>('button[data-diagram-export]');
    if (exportButton) {
      const diagram = exportButton.closest<HTMLElement>('.mermaid-diagram');
      const svg = diagram?.querySelector<SVGSVGElement>('svg');
      const format = exportButton.dataset.diagramExport as DiagramImageFormat | undefined;
      if (!diagram || !svg || !format) return;
      event.preventDefault();
      const diagrams = [...(host.current?.querySelectorAll('.mermaid-diagram') ?? [])];
      const index = Math.max(0, diagrams.indexOf(diagram)) + 1;
      exportButton.disabled = true;
      exportButton.setAttribute('aria-busy', 'true');
      void downloadDiagram(svg, name, index, format).catch((error: unknown) => {
        const message = t('图表图片保存失败：{0}', String(error).replace(/^Error:\s*/, ''));
        const notice = document.createElement('span');
        notice.className = 'diagram-export-error';
        notice.setAttribute('role', 'alert');
        notice.textContent = message;
        diagram.querySelector('.diagram-export-error')?.remove();
        diagram.appendChild(notice);
        setTimeout(() => notice.remove(), 5_000);
      }).finally(() => {
        exportButton.disabled = false;
        exportButton.removeAttribute('aria-busy');
      });
      return;
    }
    const contents = target.closest<HTMLAnchorElement>('a[data-toc-target]');
    if (contents?.dataset.tocTarget) {
      event.preventDefault();
      host.current?.querySelector<HTMLElement>(`[data-toc-heading="${contents.dataset.tocTarget}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const footnoteRef = target.closest<HTMLAnchorElement>('a[data-footnote-ref]');
    if (footnoteRef) {
      event.preventDefault();
      host.current?.querySelector<HTMLElement>(`[data-footnote-id="${footnoteRef.dataset.footnoteRef}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const footnoteBackref = target.closest<HTMLAnchorElement>('a[data-footnote-backref]');
    if (footnoteBackref) {
      event.preventDefault();
      host.current?.querySelector<HTMLElement>(
        `[data-footnote-reference="${footnoteBackref.dataset.footnoteBackref}"]`
      )?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const task = target.closest<HTMLInputElement>('input[data-task-line]');
    if (task && onTask) {
      onTask(Number(task.dataset.taskLine), task.checked);
      return;
    }
    const image = target.closest<HTMLImageElement>('img[data-private-image]');
    if (image) { onImage(image.src); return; }
    const note = target.closest<HTMLAnchorElement>('a[data-note-id]');
    if (note?.dataset.noteId && onNote) {
      event.preventDefault();
      onNote(note.dataset.noteId);
      return;
    }
    const file = target.closest<HTMLAnchorElement>('a[data-private-file]');
    if (file?.dataset.privateFile && onFile) {
      event.preventDefault();
      onFile(file.dataset.privateFile, file.href);
    }
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}
