import { Facet, type EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

export const searchQueryFacet = Facet.define<string, string>({
  combine: (values) => values.at(-1) ?? '',
});

export interface SearchMatch {
  from: number;
  to: number;
}

// Trimmed, case-insensitive literal matching is the existing search contract; both the highlight
// decorations and the live-preview source exposure must see exactly the same ranges.
export function searchMatchRanges(state: EditorState): SearchMatch[] {
  const query = state.facet(searchQueryFacet).trim();
  if (!query) return [];
  const text = state.doc.toString();
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const matches: SearchMatch[] = [];
  let match = haystack.indexOf(needle);
  while (match >= 0) {
    matches.push({ from: match, to: match + query.length });
    match = haystack.indexOf(needle, match + query.length);
  }
  return matches;
}

export const searchHighlights = EditorView.decorations.compute([searchQueryFacet, 'doc'], (state) =>
  Decoration.set(searchMatchRanges(state).map((match) =>
    Decoration.mark({ class: 'cm-search-highlight' }).range(match.from, match.to))));
