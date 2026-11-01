import { FOLDERS, type Folder } from "../types";

export const MAX_SEARCH_LENGTH = 500;
// FTS5 gives up on very deep expressions, and nobody means 33 separate words.
const MAX_SEARCH_TERMS = 32;

export type SearchColumn = "subject" | "sender" | "recipients";

// A phrase holds only letters, numbers, marks, and single spaces, so it cannot
// close the quotes it goes inside or spell an FTS5 operator once it is quoted.
export type SearchTerm = { column: SearchColumn | null; phrase: string };

export type SearchQuery = {
  terms: SearchTerm[];
  hasAttachment: boolean;
  unread: boolean;
  starred: boolean;
  // Null searches every folder but Spam and Trash.
  folder: Folder | null;
  labels: string[];
  receivedBefore: number | null;
  receivedAfter: number | null;
};

export type ParsedSearch =
  { ok: true; query: SearchQuery } | { ok: false; problem: string };

const COLUMN_OPERATORS: Record<string, SearchColumn> = {
  from: "sender",
  to: "recipients",
  subject: "subject",
};

const TOKEN = /([^\s":]+):(?:"([^"]*)"?|(\S*))|"([^"]*)"?|(\S+)/gu;

function phraseOf(text: string): string | null {
  const phrase = text.replace(/[^\p{L}\p{N}\p{M}\p{Co}]+/gu, " ").trim();
  return /[\p{L}\p{N}\p{Co}]/u.test(phrase) ? phrase : null;
}

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

// Anything that is not a known operator with a usable value becomes plain words,
// and a known operator with an unusable value gets a plain message. So no input
// can reach FTS5 as syntax. `offsetMinutes` is the reader's Date.getTimezoneOffset,
// which makes `before:` and `after:` mean their own days.
export function parseSearch(text: string, offsetMinutes: number): ParsedSearch {
  if (text.length > MAX_SEARCH_LENGTH) {
    return {
      ok: false,
      problem: `That search is too long. Keep it under ${MAX_SEARCH_LENGTH} characters.`,
    };
  }

  const query: SearchQuery = {
    terms: [],
    hasAttachment: false,
    unread: false,
    starred: false,
    folder: null,
    labels: [],
    receivedBefore: null,
    receivedAfter: null,
  };
  const addWords = (words: string, column: SearchColumn | null = null) => {
    const phrase = phraseOf(words);
    if (phrase) query.terms.push({ column, phrase });
  };

  for (const match of text.matchAll(TOKEN)) {
    const [whole, rawOperator, quotedValue, bareValue, phrase, word] = match;
    if (rawOperator === undefined) {
      addWords(phrase ?? word ?? "");
      continue;
    }
    const operator = rawOperator.toLowerCase();
    const value = quotedValue ?? bareValue ?? "";
    const column = COLUMN_OPERATORS[operator];
    if (column && value) {
      addWords(value, column);
    } else if (operator === "is" && value) {
      const state = value.toLowerCase();
      if (state === "unread") query.unread = true;
      else if (state === "starred") query.starred = true;
      else {
        return {
          ok: false,
          problem: `We can search is:unread and is:starred, but not is:${shown(value)}.`,
        };
      }
    } else if (operator === "has" && value) {
      if (value.toLowerCase() !== "attachment") {
        return {
          ok: false,
          problem: `We can search has:attachment, but not has:${shown(value)}.`,
        };
      }
      query.hasAttachment = true;
    } else if (operator === "in" && value) {
      const folder = value.toLowerCase() as Folder;
      if (!FOLDERS.includes(folder)) {
        return {
          ok: false,
          problem: `There's no folder called "${shown(value)}". Try in:inbox, in:archive, in:sent, in:drafts, in:spam, or in:trash.`,
        };
      }
      query.folder = folder;
    } else if (operator === "label" && value) {
      query.labels.push(value);
    } else if ((operator === "before" || operator === "after") && value) {
      const day = dayStart(value, offsetMinutes);
      if (day === null) {
        return {
          ok: false,
          problem: `We couldn't read the date "${shown(value)}". Write it like 2026-03-31.`,
        };
      }
      if (operator === "before") query.receivedBefore = day;
      else query.receivedAfter = day;
    } else {
      addWords(whole);
    }
  }

  if (query.terms.length > MAX_SEARCH_TERMS) {
    return {
      ok: false,
      problem: `That search has too many words. Use up to ${MAX_SEARCH_TERMS}.`,
    };
  }
  const narrowsSomething =
    query.terms.length > 0 ||
    query.hasAttachment ||
    query.unread ||
    query.starred ||
    query.folder !== null ||
    query.labels.length > 0 ||
    query.receivedBefore !== null ||
    query.receivedAfter !== null;
  if (!narrowsSomething) {
    return {
      ok: false,
      problem:
        "Add a word to search for. Punctuation on its own can't be found.",
    };
  }
  return { ok: true, query };
}

export function toMatchExpression(terms: readonly SearchTerm[]): string | null {
  if (terms.length === 0) return null;
  return terms
    .map(({ column, phrase }) =>
      column ? `${column} : "${phrase}"` : `"${phrase}"`,
    )
    .join(" AND ");
}
