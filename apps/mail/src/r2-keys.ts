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
