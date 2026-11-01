import type { Address } from "./types";

const MAX_RFC_ID_LENGTH = 998;
const MAX_REFERENCES = 50;

export const SUBJECT_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map(
    (match) => match[1]!,
  );
  const ids = bracketed.length ? bracketed : value.trim().split(/\s+/);
  return ids.filter((id) => id.length > 0 && id.length <= MAX_RFC_ID_LENGTH);
}

// Oldest first, with the direct parent last. A hostile header can list thousands
// of ids, so keep the thread's root and its most recent ancestors. RFC 5322
// suggests the same when shortening References.
export function parseReferences(
  references: string | null | undefined,
  inReplyTo: string | null | undefined,
): string[] {
  const parent = parseMessageIds(inReplyTo).at(-1);
  const chain = [...parseMessageIds(references), ...(parent ? [parent] : [])];
  const unique = [...new Set(chain.toReversed())].toReversed();
  if (unique.length <= MAX_REFERENCES) return unique;
  return [unique[0]!, ...unique.slice(-(MAX_REFERENCES - 1))];
}

const REPLY_PREFIXES = "re|aw|sv|vs|antw|rv";
const FORWARD_PREFIXES = "fwd?|wg";
const SUBJECT_PREFIX = new RegExp(
  `^\\s*(?:((?:${REPLY_PREFIXES}))|(?:${FORWARD_PREFIXES}))(?:\\[\\d+\\])?\\s*:\\s*`,
  "i",
);
const LIST_TAG = /^\s*\[[^\]]{0,64}\]\s*/;
const MAX_SUBJECT_SCAN = 1024;

export function normalizeSubject(subject: string | null | undefined): {
  normalized: string;
  isReply: boolean;
} {
  let rest = (subject ?? "").slice(0, MAX_SUBJECT_SCAN);
  let isReply = false;
  for (;;) {
    const tag = LIST_TAG.exec(rest);
    if (tag) {
      rest = rest.slice(tag[0].length);
      continue;
    }
    const prefix = SUBJECT_PREFIX.exec(rest);
    if (!prefix) break;
    if (prefix[1]) isReply = true;
    rest = rest.slice(prefix[0].length);
  }
  return {
    normalized: rest
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase(),
    isReply,
  };
}

export function participantsOf(message: {
  from: Address | null;
  to: Address[];
  cc: Address[];
}): string[] {
  const all = [
    ...(message.from ? [message.from] : []),
    ...message.to,
    ...message.cc,
  ];
  return [...new Set(all.map((person) => person.address.toLowerCase()))];
}

type SubjectLinkFacts = { from: string | null; participants: string[] };

// Both senders must appear in each other's message, so the check gives the same
// answer whichever of the two arrives first.
export function sameConversation(
  a: SubjectLinkFacts,
  b: SubjectLinkFacts,
): boolean {
  return (
    a.from !== null &&
    b.from !== null &&
    a.participants.includes(b.from) &&
    b.participants.includes(a.from)
  );
}
