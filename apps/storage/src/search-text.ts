// Shared with the browser, so nothing here may import server code.
export const MAX_SEARCH_LENGTH = 200;
// FTS5 gives up on very deep expressions, and no name holds this many words.
const MAX_WORDS = 16;

// Everything but letters, numbers, and marks splits words, which is what the index does
// to names. So a word can't close the quotes it goes inside or spell an FTS5 operator, and
// a word of marks alone, which the index holds nothing for, is dropped.
export function searchWords(text: string): string[] {
  return text
    .slice(0, MAX_SEARCH_LENGTH)
    .split(/[^\p{L}\p{N}\p{M}\p{Co}]+/u)
    .filter((word) => /[\p{L}\p{N}\p{Co}]/u.test(word))
    .slice(0, MAX_WORDS);
}

// Every word must start a word in the name, in any order.
export const toMatchExpression = (words: readonly string[]) =>
  words.map((word) => `"${word}"*`).join(" AND ");
