import type { Address } from "../types";
import type { DraftContent, DraftPrefill } from "./types";
import { cleanSubject } from "./validate";

const MARKUP = /<!--[\s\S]*?-->|<[^>]*>/g;
const BLANK_ENTITY = /&(?:nbsp|#0*160|#x0*a0);/gi;
const INVISIBLE = /[\s​-‍⁠﻿]/g;

// Anything this misreads counts as written, so it can only keep words, never lose them.
const isBlankHtml = (html: string) =>
  !html.replace(MARKUP, "").replace(BLANK_ENTITY, "").replace(INVISIBLE, "");

const addressesOf = (people: Address[]) =>
  new Set(people.map(({ address }) => address.toLowerCase()));

const samePeople = (one: Address[], other: Address[]) => {
  const [first, second] = [addressesOf(one), addressesOf(other)];
  return first.size === second.size && [...first].every((a) => second.has(a));
};

// The one rule for whether a draft is worth keeping, used by the server to decide and
// by the screen to avoid asking. The address it goes out from, leaving out the quote,
// and removing a forwarded file all take something away or choose, so they add nothing.
export function holdsSomethingAdded(
  draft: {
    content: Pick<DraftContent, "to" | "cc" | "bcc" | "subject" | "html">;
    uploads: number;
  },
  prefill: DraftPrefill,
): boolean {
  const { to, cc, bcc, subject, html } = draft.content;
  return (
    draft.uploads > 0 ||
    !isBlankHtml(html) ||
    bcc.length > 0 ||
    cleanSubject(subject) !== prefill.subject ||
    !samePeople(to, prefill.to) ||
    !samePeople(cc, prefill.cc)
  );
}
