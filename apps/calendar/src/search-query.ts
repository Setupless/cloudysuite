// Shared with the browser, so nothing here may import server code.
import { type ParsedWords, parseWords } from "@cloudysuite/search";

export { MAX_SEARCH_LENGTH } from "@cloudysuite/search";

export type ParsedEventSearch = ParsedWords;

export const parseEventSearch = (text: string): ParsedEventSearch =>
  parseWords(text, "Type a word from an event's title, place, or notes.");
