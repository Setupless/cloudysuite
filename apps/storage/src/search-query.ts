// Shared with the browser, so nothing here may import server code.
import type { UserId } from "@cloudysuite/access";
import {
  MAX_SEARCH_WORDS,
  phraseTerm,
  type SearchTerm,
  wordsOf,
  wordTerms,
} from "@cloudysuite/search";
import { FILE_TYPES, type FileType } from "./file-types";

export const MAX_SEARCH_LENGTH = 200;

export type ItemType = FileType | "folder";
export const ITEM_TYPES: readonly ItemType[] = ["folder", ...FILE_TYPES];

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

export const shown = (value: string) =>
  value.length > 40 ? `${value.slice(0, 40)}…` : value;

// How far ahead of UTC the clocks in a zone are at an instant, in milliseconds.
function offsetAt(zone: Intl.DateTimeFormat, at: number): number {
  const name = zone
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT(?:([+-])(\d\d):(\d\d)(?::(\d\d))?)?$/.exec(name ?? "");
  if (!match) throw new Error(`Unexpected time zone offset ${name}`);
  const [, sign, hours = "0", minutes = "0", seconds = "0"] = match;
  const ms =
    ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  return sign === "-" ? -ms : ms;
}

function dayStart(value: string, timeZone: string): number | null {
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
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const midnight = utc.getTime();
  // The offset at UTC midnight can be the one from before the clocks changed, so the
  // offset at the first guess decides. When the clocks jump forward at midnight, that
  // lands on the day before, and the day starts at the jump instead. A day whose midnight
  // repeats, or whose jump starts before midnight, can start up to 3 hours late. No zone
  // has done that since 2023.
  const early = midnight - offsetAt(zone, midnight);
  const start = midnight - offsetAt(zone, early);
  return start + offsetAt(zone, start) < midnight ? early : start;
}

const TYPE_CHOICES = `${ITEM_TYPES.slice(0, -1)
  .map((type) => `type:${type}`)
  .join(", ")}, or type:${ITEM_TYPES.at(-1)}`;

// Anything that isn't a known operator with a usable value becomes plain words, and a
// known operator with an unusable value gets a plain message. So no input can reach FTS5
// as syntax. `timeZone` is the reader's IANA zone, which makes `before:` and `after:`
// mean their own days.
export function parseSearch(text: string, timeZone: string): ParsedSearch {
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
  const addWords = (words: string, asPhrase: boolean) => {
    const phrase = asPhrase ? phraseTerm(words) : null;
    query.terms.push(
      ...(asPhrase ? (phrase ? [phrase] : []) : wordTerms(words)),
    );
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
          problem: `We can't search for type:${shown(value)}. Try ${TYPE_CHOICES}.`,
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
      const day = dayStart(value, timeZone);
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

  if (query.terms.length > MAX_SEARCH_WORDS) {
    return {
      ok: false,
      problem: `That search has too many words. Use up to ${MAX_SEARCH_WORDS}.`,
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
