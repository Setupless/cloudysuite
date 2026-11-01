import type { MailboxId } from "@cloudysuite/access";
import type { BodyKind } from "./types";

// Keys come only from the mailbox id and the raw hash, so a retry writes to the
// same keys, and nothing the sender chose, such as a file name, reaches a key.
export function messagePrefix(mailboxId: MailboxId, rawHash: string): string {
  return `mailboxes/${mailboxId}/messages/${rawHash}/`;
}

export const rawKey = (prefix: string) => `${prefix}raw.eml`;

export const bodyKey = (prefix: string, kind: BodyKind) =>
  `${prefix}body.${kind}`;

export const attachmentKey = (prefix: string, position: number) =>
  `${prefix}attachments/${position}`;
