import type { Address, MessageDetail } from "../types";
import { cleanSubject } from "./validate";
import type { ComposeMode } from "./types";

const lower = (address: string) => address.toLowerCase();

function withoutRepeats(people: Address[], excluded: ReadonlySet<string>) {
  const seen = new Set(excluded);
  return people.filter((person) => {
    const key = lower(person.address);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Replying to our own sent message goes on to the same people, not back to ourselves.
export function replyRecipients(
  parent: Pick<MessageDetail, "from" | "replyTo" | "to" | "cc">,
  mode: ComposeMode,
  ownAddresses: readonly string[],
): { to: Address[]; cc: Address[] } {
  if (mode !== "reply" && mode !== "replyAll") return { to: [], cc: [] };
  const own = new Set(ownAddresses.map(lower));
  const fromUs = parent.from !== null && own.has(lower(parent.from.address));
  const senders = parent.replyTo.length
    ? parent.replyTo
    : parent.from
      ? [parent.from]
      : [];
  const to = withoutRepeats(fromUs ? parent.to : senders, own);
  if (mode === "reply") {
    return { to: to.length ? to : withoutRepeats(parent.to, own), cc: [] };
  }
  const taken = new Set([...own, ...to.map(({ address }) => lower(address))]);
  const others = fromUs ? parent.cc : [...parent.to, ...parent.cc];
  return { to, cc: withoutRepeats(others, taken) };
}

const REPLY_PREFIX = /^\s*re\s*:/i;
const FORWARD_PREFIX = /^\s*(?:fwd?|fw)\s*:/i;

export function composeSubject(
  subject: string | null,
  mode: ComposeMode,
): string {
  const text = cleanSubject(subject ?? "");
  if (mode === "forward") {
    return FORWARD_PREFIX.test(text) ? text : cleanSubject(`Fwd: ${text}`);
  }
  if (mode === "reply" || mode === "replyAll") {
    return REPLY_PREFIX.test(text) ? text : cleanSubject(`Re: ${text}`);
  }
  return text;
}

// Answers from the address the message reached, so a reply to sales@ comes from sales@.
export function defaultFromAddress(
  parent: Pick<MessageDetail, "envelopeTo" | "to" | "cc" | "from"> | null,
  ownAddresses: readonly string[],
): string {
  const own = new Set(ownAddresses.map(lower));
  const candidates = parent
    ? [
        parent.envelopeTo ?? "",
        ...[...parent.to, ...parent.cc].map(({ address }) => address),
        parent.from?.address ?? "",
      ]
    : [];
  return (
    candidates.map(lower).find((address) => own.has(address)) ??
    ownAddresses[0] ??
    ""
  );
}
