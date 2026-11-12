// Shared with the browser, so nothing here may import server code.
import { type ParsedWords, parseWords } from "@cloudysuite/search";

export { MAX_SEARCH_LENGTH } from "@cloudysuite/search";

export type ParsedTaskSearch = ParsedWords;

export const parseTaskSearch = (text: string): ParsedTaskSearch =>
  parseWords(text, "Type a word from a task, or someone's name.");
