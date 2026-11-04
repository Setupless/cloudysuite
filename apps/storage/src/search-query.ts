// Shared with the browser, so nothing here may import server code.
import type { UserId } from "@cloudysuite/access";
import { FILE_TYPES, type FileType } from "./file-types";

export const MAX_SEARCH_LENGTH = 200;
// FTS5 gives up on very deep expressions, and no name holds this many words.
const MAX_WORDS = 16;

export type ItemType = FileType | "folder";
const ITEM_TYPES: readonly ItemType[] = ["folder", ...FILE_TYPES];

// A term holds words of letters, numbers, and marks joined by single spaces, so it can't
// close the quotes it goes inside or spell an FTS5 operator. A quoted phrase is one term.
type SearchTerm = string & { readonly __brand: "SearchTerm" };

type Narrowing = {
  terms: SearchTerm[];
  type: ItemType | null;
  starred: boolean;
  changedAfter: number | null;
  changedBefore: number | null;
};

// `owner:` as typed. "me" needs no lookup, and anything else is words of a name or address.
export type OwnerFilter = { kind: "me" } | { kind: "named"; words: string };

export type SearchQuery = Narrowing & { owner: OwnerFilter | null };

// What each drive is asked, once the Worker knows who `owner:` means.
export type DriveSearch = Narrowing & { owners: UserId[] | null };

export type ParsedSearch =
  { ok: true; query: SearchQuery } | { ok: false; problem: string };

const TOKEN = /([^\s":]+):(?:"([^"]*)"?|(\S*))|"([^"]*)"?|(\S+)/gu;

// Everything but letters, numbers, and marks splits words, which is what the index does
// to names. A word of marks alone, which the index holds nothing for, is dropped.
export const wordsOf = (text: string): string[] =>
  text
    .split(/[^\p{L}\p{N}\p{M}\p{Co}]+/u)
    .filter((word) => /[\p{L}\p{N}\p{Co}]/u.test(word));

const shown = (value: string) =>
  value.length > 40 ? `${value.slice(0, 40)}…` : value;

function dayStart(value: string, offsetMinutes: number): number | null {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  // Date.UTC reads the years 0 to 99 as 1900 to 1999, and setUTCFullYear does not.
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return utc.getTime() + offsetMinutes * 60_000;
}

const TYPE_LIST = ITEM_TYPES.map((type) => `type:${type}`).join(", ");

// Anything that isn't a known operator with a usable value becomes plain words, and a
// known operator with an unusable value gets a plain message. So no input can reach FTS5
// as syntax. `offsetMinutes` is the reader's Date.getTimezoneOffset, which makes `before:`
// and `after:` mean their own days.
export function parseSearch(text: string, offsetMinutes: number): ParsedSearch {
  if (text.length > MAX_SEARCH_LENGTH) {
    return {
      ok: false,
      problem: `That search is too long. Keep it under ${MAX_SEARCH_LENGTH} characters.`,
    };
  }
  const query: SearchQuery = {
    terms: [],
    type: null,
    starred: false,
    owner: null,
    changedAfter: null,
    changedBefore: null,
  };
  let wordCount = 0;
  const addWords = (words: string, asPhrase: boolean) => {
    const found = wordsOf(words);
    wordCount += found.length;
    if (found.length === 0) return;
    const terms = asPhrase ? [found.join(" ")] : found;
    query.terms.push(...(terms as SearchTerm[]));
  };

  for (const match of text.matchAll(TOKEN)) {
    const [whole, rawOperator, quotedValue, bareValue, phrase, word] = match;
    if (rawOperator === undefined) {
      if (phrase !== undefined) addWords(phrase, true);
      else addWords(word ?? "", false);
      continue;
    }
    const operator = rawOperator.toLowerCase();
    const value = quotedValue ?? bareValue ?? "";
    if (operator === "type" && value) {
      const type = ITEM_TYPES.find((known) => known === value.toLowerCase());
      if (!type) {
        return {
          ok: false,
          problem: `We can't search for type:${shown(value)}. Try ${TYPE_LIST}.`,
        };
      }
      query.type = type;
    } else if (operator === "is" && value) {
      if (value.toLowerCase() !== "starred") {
        return {
          ok: false,
          problem: `We can search is:starred, but not is:${shown(value)}.`,
        };
      }
      query.starred = true;
    } else if (operator === "owner" && value) {
      if (value.toLowerCase() === "me") {
        query.owner = { kind: "me" };
      } else if (wordsOf(value).length > 0) {
        query.owner = { kind: "named", words: value };
      } else {
        return {
          ok: false,
          problem: `Write part of a name or email address after owner:, or owner:me.`,
        };
      }
    } else if ((operator === "before" || operator === "after") && value) {
      const day = dayStart(value, offsetMinutes);
      if (day === null) {
        return {
          ok: false,
          problem: `We couldn't read the date "${shown(value)}". Write it like 2026-03-31.`,
        };
      }
      if (operator === "before") query.changedBefore = day;
      else query.changedAfter = day;
    } else {
      addWords(whole, false);
    }
  }

  if (wordCount > MAX_WORDS) {
    return {
      ok: false,
      problem: `That search has too many words. Use up to ${MAX_WORDS}.`,
    };
  }
  const narrowsSomething =
    query.terms.length > 0 ||
    query.type !== null ||
    query.starred ||
    query.owner !== null ||
    query.changedAfter !== null ||
    query.changedBefore !== null;
  if (!narrowsSomething) {
    return {
      ok: false,
      problem: "Type a word from the name of a file or folder.",
    };
  }
  return { ok: true, query };
}

// Every term must start a word in the name, in any order, and a phrase's words must
// come one after another.
export const toMatchExpression = (terms: readonly SearchTerm[]) =>
  terms.length === 0 ? null : terms.map((term) => `"${term}"*`).join(" AND ");
