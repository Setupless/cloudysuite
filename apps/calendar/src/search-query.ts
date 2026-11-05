// Shared with the browser, so nothing here may import server code.
import {
  MAX_SEARCH_WORDS,
  type SearchTerm,
  wordTerms,
} from "@cloudysuite/search";

export const MAX_SEARCH_LENGTH = 200;

export type ParsedEventSearch =
  { ok: true; terms: SearchTerm[] } | { ok: false; problem: string };

// Calendar has no operators, so anything typed is words, and punctuation only splits
// them. No input can reach FTS5 as syntax.
export function parseEventSearch(text: string): ParsedEventSearch {
  if (text.length > MAX_SEARCH_LENGTH) {
    return {
      ok: false,
      problem: `That search is too long. Keep it under ${MAX_SEARCH_LENGTH} characters.`,
    };
  }
  const terms = wordTerms(text);
  if (terms.length === 0) {
    return {
      ok: false,
      problem: "Type a word from an event's title, place, or notes.",
    };
  }
  if (terms.length > MAX_SEARCH_WORDS) {
    return {
      ok: false,
      problem: `That search has too many words. Use up to ${MAX_SEARCH_WORDS}.`,
    };
  }
  return { ok: true, terms };
}
