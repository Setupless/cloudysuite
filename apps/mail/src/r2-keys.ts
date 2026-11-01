import type { MailboxId } from "@cloudysuite/access";
import type { BodyKind } from "./types";

// One prefix per delivery attempt, never derived from the content. Cleaning up a
// deleted message can then never touch a later copy of the same bytes, and nothing
// the sender chose, such as a file name, reaches a key.
export function newMessagePrefix(mailboxId: MailboxId): string {
  return `mailboxes/${mailboxId}/messages/${crypto.randomUUID()}/`;
}

export const rawKey = (prefix: string) => `${prefix}raw.eml`;

export const bodyKey = (prefix: string, kind: BodyKind) =>
  `${prefix}body.${kind}`;

export const attachmentKey = (prefix: string, position: number) =>
  `${prefix}attachments/${position}`;

export const importFilePrefix = (mailboxId: MailboxId, jobId: string) =>
  `mailboxes/${mailboxId}/imports/${jobId}/`;

export const importFileKey = (mailboxId: MailboxId, jobId: string) =>
  `${importFilePrefix(mailboxId, jobId)}file.mbox`;

// Every message in one import batch shares this start, so one queued deletion can
// clear what a batch left behind when it died. Only a batch that never committed
// is ever queued this way. The `/` that ends a message's own prefix keeps message
// 1 and message 10 apart when one of them is deleted later.
export const importAttemptPrefix = (mailboxId: MailboxId, attempt: string) =>
  `mailboxes/${mailboxId}/messages/${attempt}-`;

export const importMessagePrefix = (attemptPrefix: string, index: number) =>
  `${attemptPrefix}${index}/`;

// Everything a message holds before it is sent. Its files go through the deletion
// queue with this prefix once it is sent or discarded.
export const outgoingPrefix = (mailboxId: MailboxId, outgoingId: string) =>
  `mailboxes/${mailboxId}/outgoing/${outgoingId}/`;

export const quoteHtmlKey = (prefix: string) => `${prefix}quote.html`;
export const quoteTextKey = (prefix: string) => `${prefix}quote.txt`;

export const attachmentUploadKey = (prefix: string, uploadId: string) =>
  `${prefix}attachments/${uploadId}`;

export const forwardedAttachmentKey = (prefix: string, position: number) =>
  `${prefix}forwarded/${position}`;

// Fixed per send job, so storing the copy again after a crash overwrites its own
// objects. It sits beside the draft's prefix, not inside it, because that one is deleted.
export const sentCopyPrefix = (outgoingPrefixValue: string) =>
  `${outgoingPrefixValue.slice(0, -1).replace("/outgoing/", "/messages/sent-")}/`;
