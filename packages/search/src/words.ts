// Shared with the browser, so nothing here may import server code.

// FTS5 gives up on very deep expressions, and no search needs this many words.
export const MAX_SEARCH_WORDS = 16;

// A term holds words of letters, numbers, and marks joined by single spaces, so it can't
// close the quotes it goes inside or spell an FTS5 operator. A quoted phrase is one term.
export type SearchTerm = string & { readonly __brand: "SearchTerm" };

// Everything but letters, numbers, and marks splits words, which is what the index does
// to text. A word of marks alone, which the index holds nothing for, is dropped.
export const wordsOf = (text: string): string[] =>
  text
    .split(/[^\p{L}\p{N}\p{M}\p{Co}]+/u)
    .filter((word) => /[\p{L}\p{N}\p{Co}]/u.test(word));

export const wordTerms = (text: string) => wordsOf(text) as SearchTerm[];

export function phraseTerm(text: string): SearchTerm | null {
  const words = wordsOf(text);
  return words.length === 0 ? null : (words.join(" ") as SearchTerm);
}

// Every term must start a word, in any order, and a phrase's words must come one after
// another. Case and accents don't matter only when the index's tokenizer is unicode61
// with remove_diacritics.
export const toPrefixMatch = (terms: readonly SearchTerm[]) =>
  terms.length === 0 ? null : terms.map((term) => `"${term}"*`).join(" AND ");

const folded = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

// Each word typed must start a word of the text, in any order, whatever the case or
// accents, the way names are searched. Nothing typed matches everything.
export function matchesWords(typed: string, text: string): boolean {
  const wanted = wordsOf(folded(typed));
  const theirs = wordsOf(folded(text));
  return wanted.every((word) => theirs.some((their) => their.startsWith(word)));
}

export const MAX_SEARCH_LENGTH = 200;

export type ParsedWords =
  { ok: true; terms: SearchTerm[] } | { ok: false; problem: string };

// For a search with no operators, so anything typed is words, and punctuation only splits
// them. No input can reach FTS5 as syntax. `empty` says what to type instead.
export function parseWords(text: string, empty: string): ParsedWords {
  if (text.length > MAX_SEARCH_LENGTH) {
    return {
      ok: false,
      problem: `That search is too long. Keep it under ${MAX_SEARCH_LENGTH} characters.`,
    };
  }
  const terms = wordTerms(text);
  if (terms.length === 0) return { ok: false, problem: empty };
  if (terms.length > MAX_SEARCH_WORDS) {
    return {
      ok: false,
      problem: `That search has too many words. Use up to ${MAX_SEARCH_WORDS}.`,
    };
  }
  return { ok: true, terms };
}
