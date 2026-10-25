import { idPattern } from '../shared/types';

const imagePath = /^(?:\/api\/images\/|\/api\/public\/shares\/[a-f0-9]{64}\/images\/)([0-9a-f-]{36})$/i;
const filePath = /^(?:\/api\/files\/|\/api\/public\/shares\/[a-f0-9]{64}\/files\/)([0-9a-f-]{36})$/i;

// Shared with Preview: the editor's live preview must not accept a wider set of media paths than reading does.
export function privateImageId(source: string): string | null {
  const id = imagePath.exec(markdownTarget(source))?.[1];
  return id && idPattern.test(id) ? id : null;
}

export function privateFileId(source: string): string | null {
  const id = filePath.exec(markdownTarget(source))?.[1];
  return id && idPattern.test(id) ? id : null;
}

const namedEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', tab: '\t', newline: '\n',
  sol: '/', bsol: '\\', lpar: '(', rpar: ')', num: '#', percnt: '%', period: '.', comma: ',', excl: '!',
  quest: '?', equals: '=', semi: ';', commat: '@', dollar: '$', ast: '*', plus: '+', lowbar: '_',
};

// Markdown links may carry backslash escapes and HTML entities that hide a scheme from a raw prefix test.
function decodeMarkdownTarget(source: string): string {
  let value = source.trim().replace(/\\([!-/:-@[-`{-~])/g, '$1');
  for (let pass = 0; pass < 3; pass++) {
    const next = value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return namedEntities[name.toLocaleLowerCase()] ?? match;
    });
    if (next === value) break;
    value = next;
  }
  return value.trim();
}

const angleTarget = /^<([\s\S]*)>$/;

/**
 * The Markdown target value of a `(…)` destination: `<…>` drops CommonMark's syntax shell, then backslash escapes
 * and HTML entities decode. Every link, attachment and image target goes through this one entry, so a shell never
 * reaches a protocol or resource test and a target stays exactly one spelling in every surface.
 */
export function markdownTarget(source: string): string {
  const trimmed = source.trim();
  return decodeMarkdownTarget(angleTarget.exec(trimmed)?.[1] ?? trimmed);
}

const allowedProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:']);

// Browsers normalise backslashes to slashes, so `\evil.example/x` and `\\evil.example/x` would turn a
// same-site relative target into another origin. Everything relative must resolve back to this origin.
function sameOrigin(href: string): boolean {
  const base = typeof location === 'undefined' ? '' : location.href;
  if (!base) return false;
  try {
    return new URL(href, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/**
 * Returns the href the editor may put on an anchor, or null when the source target stays plain text.
 * `validateLink` is MarkdownIt's own `validateLink` from the reading renderer so both surfaces share one
 * baseline rejection; the protocol allow-list is deliberately narrower than reading (ftp etc. stay text).
 */
export function safeMarkdownHref(source: string, validateLink: (href: string) => boolean): string | null {
  const href = markdownTarget(source);
  if (!href) return null;
  // Control characters can split a scheme or hide it from URL parsing in browsers.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(href)) return null;
  if (/\s/.test(href)) return null;
  if (href.includes('\\')) return null;
  if (href.startsWith('#')) return href.length > 1 ? href : null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (scheme) {
    return allowedProtocols.has(`${scheme[1].toLocaleLowerCase()}:`) && validateLink(href) ? href : null;
  }
  // Root-relative and plain relative targets are only usable when the browser keeps them on this origin.
  return validateLink(href) && sameOrigin(href) ? href : null;
}

// CommonMark autolinks are either an absolute URI with a scheme or an email address; an email must become a
// `mailto:` target instead of a same-origin relative path.
const emailAutolink = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function autolinkHref(source: string, validateLink: (href: string) => boolean): string | null {
  const value = source.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]{1,31}:/i.test(value)) return safeMarkdownHref(value, validateLink);
  return emailAutolink.test(value) ? safeMarkdownHref(`mailto:${value}`, validateLink) : null;
}

export function toggleMarkdownTask(content: string, sourceLine: number, checked: boolean): string {
  const lines = content.split('\n');
  if (!Number.isInteger(sourceLine) || sourceLine < 0 || sourceLine >= lines.length) return content;
  lines[sourceLine] = lines[sourceLine].replace(
    /^([ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+[ \t>]*)*)\[([ xX]?)\](?=\s|$)/,
    (_source, prefix: string) => `${prefix}[${checked ? 'x' : ' '}]`,
  );
  return lines.join('\n');
}
