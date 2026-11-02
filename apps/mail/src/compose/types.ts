import {
  type Address,
  type AttachmentId,
  type MailboxId,
  MAX_MESSAGE_BYTES,
  type ThreadId,
  type MessageId,
} from "../types";

export type OutgoingId = string & { readonly __brand: "OutgoingId" };

// One row carries a message from first keystroke to delivery:
//
// A row exists only once someone has added something. Until then a reply is a prefill
// held by the screen, which names the message it answers on the first save.
//
//   draft -> scheduled -> sending -> accepted -> sent
//     ^         |            |
//     |         |            +-> failed: the service refused it, so nothing went out
//     |         |            +-> unknown: it may have gone out, and is never retried
//     +---------+  undo, or reopening a failed or unknown message
//
// `accepted` means the service took it and only our stored copy is left to write,
// so repeating that step can never send anything a second time.
export const OUTGOING_STATES = [
  "draft",
  "scheduled",
  "sending",
  "accepted",
  "sent",
  "failed",
  "unknown",
] as const;
export type OutgoingState = (typeof OUTGOING_STATES)[number];

export const COMPOSE_MODES = ["new", "reply", "replyAll", "forward"] as const;
export type ComposeMode = (typeof COMPOSE_MODES)[number];

export type ParentFacts = {
  messageId: MessageId;
  rfcMessageId: string | null;
  references: string[];
};

export type DraftContent = {
  from: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  includeQuote: boolean;
};

// What a reply or forward opens with, none of which anyone added.
export type DraftPrefill = Pick<DraftContent, "to" | "cc" | "subject">;

export const NOTHING_PREFILLED: DraftPrefill = { to: [], cc: [], subject: "" };

export type OutgoingAttachment = {
  // While a forward has no row, this is the original's attachment id, the same as
  // `carriedFrom`. Once it has one, this is the draft's own id for the file.
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  // The original's attachment, for a file that came with a forward and wasn't uploaded.
  carriedFrom: AttachmentId | null;
};

// What the first save of a reply says about the row it needs. The server reads the rest
// from the original message, so the screen never gets to choose recipients or headers.
export type DraftStart = {
  mode: Exclude<ComposeMode, "new">;
  parentMessageId: MessageId;
  carried: AttachmentId[];
  includeQuote: boolean;
};

export const SEND_FAILURES = {
  senderNotVerified:
    "This address isn't set up to send mail yet. Ask your admin to finish setting up the domain, then send it again.",
  senderDomainUnavailable:
    "This address's domain isn't set up to send mail yet. Ask your admin to finish setting up the domain, then send it again.",
  dailyLimit:
    "Your organisation has reached today's sending limit. New accounts start with a low limit that rises over time. Send it again tomorrow.",
  rateLimited:
    "Too much mail is going out right now. Wait a few minutes, then send it again.",
  accountSuspended:
    "Cloudflare has paused sending for your organisation. Ask your admin to check the Cloudflare account.",
  recipientNotAllowed:
    "Your organisation's settings don't allow mail to one of these people. Ask your admin, or remove them and send it again.",
  recipientSuppressed:
    "One of these people can't receive mail from your organisation, because an earlier message to them bounced or they reported it. Remove them and send it again.",
  tooLarge:
    "This message is too large to send. Remove an attachment, then send it again.",
  tooManyRecipients:
    "This message has too many recipients. Remove some, then send it again.",
  invalidMessage:
    "Something in this message couldn't be sent. Check the addresses and the subject, then send it again.",
  deliveryRefused:
    "A receiving mail server refused this message, so some people may not have it. Check the addresses, then send it again.",
  attachmentMissing:
    "One of the attachments is gone, so this wasn't sent. Attach it again, then send it again.",
  storageUnavailable:
    "We couldn't read this message's attachments, so it wasn't sent. Try sending it again.",
  mailOff:
    "Mail was turned off, so this wasn't sent. Ask your admin to turn it back on, then send it again.",
  senderLostAccess:
    "The person who pressed Send can no longer use this mailbox, so this wasn't sent. If it should still go, someone with access can read it through and send it again.",
  fromAddressGone:
    "The address this was going out from no longer belongs to this mailbox, so it wasn't sent. Check the From address, then send it again.",
  checkUnavailable:
    "We couldn't confirm this was still allowed to go out, so it wasn't sent. Wait a few minutes, then send it again.",
} as const;
export type SendFailure = keyof typeof SEND_FAILURES;

export const UNKNOWN_OUTCOME_TEXT =
  "We can't tell whether this was sent. Check with the recipient before sending again.";

export type OutgoingSummary = {
  id: OutgoingId;
  state: OutgoingState;
  mode: ComposeMode;
  to: Address[];
  subject: string;
  snippet: string;
  updatedAt: number;
  updatedByName: string;
  attachmentCount: number;
  // The conversation this belongs to, once it has one: the parent's while it is a
  // draft, and the stored copy's once sent.
  threadId: ThreadId | null;
  failure: SendFailure | null;
  // Until the undo window closes. Counted by the server, so a wrong clock on the
  // person's device doesn't change what Undo can do.
  msUntilDue: number | null;
  // Refused for now and waiting to try again, which can take minutes.
  retrying: boolean;
  // True for the person who pressed Send, who is the one to tell how it went.
  sentByViewer: boolean;
};

export type OutgoingDetail = OutgoingSummary & {
  revision: number;
  parent: ParentFacts | null;
  content: DraftContent;
  attachments: OutgoingAttachment[];
  quote: { bytes: number; designed: boolean } | null;
  prefill: DraftPrefill;
};

// What the editor needs to pick up a message. The server's draft has it, and so does a
// message kept on this device because it couldn't be saved.
export type DraftForEditor = Pick<
  OutgoingDetail,
  | "content"
  | "revision"
  | "mode"
  | "parent"
  | "attachments"
  | "quote"
  | "prefill"
>;

export const startOf = (draft: DraftForEditor): DraftStart | undefined =>
  draft.revision > 0 || draft.mode === "new" || !draft.parent
    ? undefined
    : {
        mode: draft.mode,
        parentMessageId: draft.parent.messageId,
        carried: draft.attachments.flatMap((file) => file.carriedFrom ?? []),
        includeQuote: draft.content.includeQuote,
      };

// `revision` is the server's revision these words were written on. Going back, they
// replace the server's draft only if it is still at that revision. Zero means no row yet,
// so `prefill`, `parent`, `quote`, and `attachments` describe what the first save makes.
export type KeptDraft = DraftForEditor & {
  id: OutgoingId;
  mailboxId: MailboxId;
  keptAt: number;
  // The server's copy can be gone by the time this is reopened, or out of reach.
  quoteHtml: string | null;
};

// What the server's draft still has, so a device can tell what no longer came along.
export type DraftHolds = {
  attachmentIds: number[];
  carriedFrom: number[];
  quote: boolean;
  threaded: boolean;
};

export type LeftOut = { files: string[]; quote: boolean; reply: boolean };

// Who changed a draft while someone's words were stuck on a device. `by` is the
// colleague's name, or null when it was the same person somewhere else.
export type DraftChange = { by: string | null };

// Stays on the device until the person has seen it. A toast could go unread.
export type KeptNote = {
  id: OutgoingId;
  mailboxId: MailboxId;
  subject: string;
  leftOut: LeftOut;
  changed: DraftChange | null;
};

export type Editor = { id: string; name: string };

export type SaveResult =
  | {
      status: "saved";
      revision: number;
      overwrote: string | null;
      holds: DraftHolds;
      // As the row holds them, so a screen that showed the original's can catch up.
      carried: OutgoingAttachment[];
    }
  // Holds nothing anyone added, so nothing was written.
  | { status: "nothing" }
  // Holds nothing anyone added, and the person left, so the row went.
  | { status: "removed" }
  // The same, but someone saved since this person last looked, so the row stayed.
  | { status: "changed" }
  | { status: "locked"; state: OutgoingState };

// `copied` means the words have a draft of their own, because the one they were written
// on moved on or was sent. `copyIsDraft` is false once that new draft has itself gone.
export type KeptSaveResult =
  | { status: "saved"; revision: number; holds: DraftHolds }
  // Holds nothing anyone added, so nothing was written and nothing is left to keep.
  | { status: "nothing" }
  | {
      status: "copied";
      copyId: OutgoingId;
      copyIsDraft: boolean;
      changed: DraftChange | null;
    };

export const UNDO_WINDOW_MS = 10_000;

export const MAX_RECIPIENTS = 50;
export const MAX_ATTACHMENTS = 32;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_SUBJECT_LENGTH = 998;

const ATTACHMENT_ENVELOPE_BYTES = 1024;
const MESSAGE_ENVELOPE_BYTES = 64 * 1024;

// Mail carries files as base64 with a line break every 76 characters.
export const encodedBytes = (bytes: number) =>
  Math.ceil(Math.ceil(bytes / 3) * 4 * (78 / 76));

// Deep lists can make the plain text longer than the HTML it comes from.
export const writtenBytes = (html: string, text: string) => {
  const encoder = new TextEncoder();
  return Math.max(
    encoder.encode(html).byteLength,
    encoder.encode(text).byteLength,
  );
};

// An upper bound on the finished message, so a message that passes always fits both
// the 25 MiB send limit and `ingest`'s limit for our stored copy. `bodyBytes` is the
// larger of the written parts, and `quoteBytes` already counts both quote parts, which
// come from the original separately and can be any size next to each other.
export function estimatedMessageBytes(parts: {
  bodyBytes: number;
  quoteBytes: number;
  attachmentSizes: number[];
}): number {
  return (
    MESSAGE_ENVELOPE_BYTES +
    2 * encodedBytes(parts.bodyBytes) +
    encodedBytes(parts.quoteBytes) +
    parts.attachmentSizes.reduce(
      (total, size) => total + encodedBytes(size) + ATTACHMENT_ENVELOPE_BYTES,
      0,
    )
  );
}

export const fitsSendLimit = (
  parts: Parameters<typeof estimatedMessageBytes>[0],
) => estimatedMessageBytes(parts) <= MAX_MESSAGE_BYTES;

export const TOO_LARGE_TEXT =
  "This message is over the 25 MB limit. Files grow by about a third in email, so attachments can add up to about 18 MB. Remove one, or share it another way.";
export const TOO_MANY_ATTACHMENTS_TEXT = `A message can have at most ${MAX_ATTACHMENTS} attachments. Remove one, or share them another way.`;
