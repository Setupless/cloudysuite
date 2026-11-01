// Why a message scored what it did. Stored with a message the filter or a rule filed
// in Spam, so the reason shown later is the reason it was filed then.
export type SpamReason =
  | { kind: "blocked"; entry: string }
  | { kind: "senderCheckFailed" }
  | { kind: "serverNotAllowed" }
  | { kind: "serverNotListed" }
  | { kind: "signatureBroken" }
  | { kind: "nameShowsOtherAddress"; shown: string }
  | { kind: "replyGoesElsewhere"; domain: string }
  | { kind: "linkShowsOtherSite"; shown: string; actual: string }
  | { kind: "runnableAttachment"; filename: string }
  | { kind: "firstContact" }
  | { kind: "shouting" }
  | { kind: "learnedSpam" }
  | { kind: "learnedReal" }
  | { kind: "allowNotProved"; entry: string }
  | { kind: "movedByRule" }
  | { kind: "opinion"; why: string };

export type SpamVerdict = {
  spam: boolean;
  score: number;
  reasons: SpamReason[];
};

// Each point value has a reason it is not higher. Only a failed DMARC check and the
// block list decide alone. Everything else is something real mail also does.
export const SPAM_THRESHOLD = 10;

export const REASON_POINTS: Record<SpamReason["kind"], number> = {
  // The sender's domain asked for this check, and the message failed it.
  blocked: SPAM_THRESHOLD,
  senderCheckFailed: SPAM_THRESHOLD,
  // Forwarded mail fails SPF too, so this needs more evidence beside it.
  serverNotAllowed: 4,
  serverNotListed: 2,
  // Mailing lists break signatures by adding a footer.
  signatureBroken: 2,
  // Some services send as "bob@example.com via Docs".
  nameShowsOtherAddress: 5,
  // Newsletters and receipts often reply to another address.
  replyGoesElsewhere: 2,
  // Click tracking does this, so newsletters do too.
  linkShowsOtherSite: 4,
  // Reaches the threshold only from a stranger, so a colleague's file still arrives.
  runnableAttachment: 9,
  // Every new customer starts as a stranger, so this only tips a close call.
  firstContact: 1,
  shouting: 1,
  // Only passes its bar when a message closely matches what was marked.
  learnedSpam: SPAM_THRESHOLD,
  learnedReal: -6,
  allowNotProved: 0,
  movedByRule: 0,
  opinion: 6,
};

// What the Worker works out before the commit, because the transaction can't read a
// large body from R2 or wait on the network.
export type MisleadingLink = { shown: string; actual: string };

// How the optional Jev check will give its answer. Nothing fills it without a key.
export type SpamOpinion = { spam: boolean; why: string };

export type SpamFacts = {
  misleadingLink: MisleadingLink | null;
  opinion: SpamOpinion | null;
};

export type SpamTraining = "spam" | "ham";

export const SENDER_LISTS = ["allow", "block"] as const;
export type SenderList = (typeof SENDER_LISTS)[number];

export type SenderEntry = { pattern: string; list: SenderList };

export type SenderWrite =
  | { ok: true; entry: SenderEntry }
  | { ok: false; status: 409; message: string };

export const MAX_SENDER_ENTRIES = 1000;
const MAX_PATTERN_LENGTH = 254;

const DOMAIN = /^(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}$/u;
const LOCAL_PART = /^[^\s@<>"(),;:]+$/;

// An address, or a domain for everyone there. Null means it is neither. A leading "@"
// is how many people write a domain.
export function parseSenderPattern(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const pattern = raw.trim().toLowerCase().replace(/^@/, "");
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return null;
  const at = pattern.lastIndexOf("@");
  if (at === -1) return DOMAIN.test(pattern) ? pattern : null;
  return LOCAL_PART.test(pattern.slice(0, at)) &&
    DOMAIN.test(pattern.slice(at + 1))
    ? pattern
    : null;
}

const REASON_KINDS = new Set(Object.keys(REASON_POINTS));

// A row written by an older release must not break reading a conversation.
export function parseStoredVerdict(raw: string | null): SpamVerdict | null {
  if (raw === null) return null;
  try {
    const verdict = JSON.parse(raw) as SpamVerdict;
    return {
      spam: verdict.spam === true,
      score: Number(verdict.score) || 0,
      reasons: Array.isArray(verdict.reasons)
        ? verdict.reasons.filter((reason) => REASON_KINDS.has(reason?.kind))
        : [],
    };
  } catch {
    return null;
  }
}
