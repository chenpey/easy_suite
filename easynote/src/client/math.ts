import type MarkdownIt from 'markdown-it';

const MAX_FORMULA_LENGTH = 10_000;

// Only $…$ and $$…$$ are formulas: \( and \[ are CommonMark escapes that existing notes use for literal brackets.
function mathEnd(source: string, start: number, end: number, delimiter: string, budget: { remaining: number }): number {
  let braces = 0;
  for (let pos = start; pos < end; pos++) {
    if (budget.remaining-- <= 0) return -1;
    if (braces <= 0 && source.startsWith(delimiter, pos)) return pos;
    if (source[pos] === '\\') pos++;
    else if (source[pos] === '{') braces++;
    else if (source[pos] === '}') braces--;
  }
  return -1;
}

export function markdownMath(md: MarkdownIt): void {
  // Bound repeated searches for malformed openers; exhausted input stays literal.
  const budgets = new WeakMap<object, { remaining: number }>();
  const budgetFor = (state: { src: string }) => {
    let budget = budgets.get(state);
    if (!budget) {
      budget = { remaining: Math.max(MAX_FORMULA_LENGTH, state.src.length * 4) };
      budgets.set(state, budget);
    }
    return budget;
  };
  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const delimiter = state.src.startsWith('$$', state.pos) ? '$$' : state.src[state.pos] === '$' ? '$' : '';
    if (!delimiter) return false;
    const start = state.pos + delimiter.length;
    if (delimiter === '$' && /\s/.test(state.src[start] ?? ' ')) return false;
    const end = mathEnd(state.src, start, Math.min(state.posMax, start + MAX_FORMULA_LENGTH + delimiter.length), delimiter, budgetFor(state));
    if (end <= start || delimiter === '$' && (/\s/.test(state.src[end - 1]) || /\d/.test(state.src[end + 1] ?? '') || state.src.slice(start, end).includes('\n'))) return false;
    if (!silent) {
      const token = state.push('math_inline', '', 0);
      token.content = state.src.slice(start, end);
      token.meta = { display: delimiter === '$$' };
    }
    state.pos = end + delimiter.length;
    return true;
  });

  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    if (!state.src.startsWith('$$', start)) return false;
    const contentStart = start + 2;
    const end = mathEnd(state.src, contentStart,
      Math.min(state.eMarks[endLine - 1], contentStart + MAX_FORMULA_LENGTH + 2), '$$', budgetFor(state));
    if (end < 0) return false;
    let line = startLine;
    while (line < endLine && state.eMarks[line] < end + 2) line++;
    if (line === endLine || state.src.slice(end + 2, state.eMarks[line]).trim()) return false;
    if (silent) return true;
    const token = state.push('math_block', '', 0);
    token.block = true;
    token.map = [startLine, line + 1];
    token.content = state.getLines(startLine, line + 1, state.blkIndent, false).trim().slice(2, -2).trim();
    token.meta = { display: true };
    state.line = line + 1;
    return true;
  });

  const render: NonNullable<typeof md.renderer.rules.math_inline> = (tokens, index) => {
    const token = tokens[index];
    const tag = token.block ? 'div' : 'span';
    const line = token.map ? ` data-source-line="${token.map[0]}"` : '';
    return `<${tag} data-math-display="${token.meta.display}"${line}>${md.utils.escapeHtml(token.content)}</${tag}>`;
  };
  md.renderer.rules.math_inline = render;
  md.renderer.rules.math_block = render;
}
