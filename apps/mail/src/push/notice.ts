import type { MailboxId, UserId } from "@cloudysuite/access";
import type { MessageId, ThreadId } from "../types";

// What one notification says, before it is addressed to anyone. Sender and subject
// come from the message, so they are hostile text everywhere they travel.
export type PushNotice =
  | {
      kind: "message";
      mailboxId: MailboxId;
      threadId: ThreadId;
      messageId: MessageId;
      sender: string;
      subject: string;
    }
  | { kind: "summary"; mailboxId: MailboxId; count: number };

// `to` lets a device refuse a notice meant for someone who used it earlier.
export type PushMessage = PushNotice & { to: UserId };

export type ShownNotification = {
  title: string;
  body: string;
  tag: string;
  path: string;
};

const MAX_SENDER_CHARACTERS = 100;
const MAX_SUBJECT_CHARACTERS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Control characters and direction overrides can make a notification read as
// something other than what it says, such as a reversed sender name. The joiner stays
// because emoji are built with it.
const UNSAFE_CHARACTERS = /(?!\u200d)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

export function plainText(raw: string, maxCharacters: number): string {
  const clean = raw.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(clean);
  return characters.length <= maxCharacters
    ? clean
    : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

export const senderText = (raw: string) =>
  plainText(raw, MAX_SENDER_CHARACTERS);
export const subjectText = (raw: string) =>
  plainText(raw, MAX_SUBJECT_CHARACTERS);

const isPositiveInteger = (raw: unknown): raw is number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0;

// The service worker's view of a push: nothing in it is trusted, even encrypted,
// because a sender wrote part of it.
export function parsePushMessage(raw: unknown): PushMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const message = raw as Record<string, unknown>;
  if (typeof message.to !== "string" || message.to === "") return null;
  if (typeof message.mailboxId !== "string" || !UUID.test(message.mailboxId)) {
    return null;
  }
  const base = {
    to: message.to as UserId,
    mailboxId: message.mailboxId as MailboxId,
  };
  if (message.kind === "summary" && isPositiveInteger(message.count)) {
    return { ...base, kind: "summary", count: message.count };
  }
  if (
    message.kind === "message" &&
    isPositiveInteger(message.threadId) &&
    isPositiveInteger(message.messageId) &&
    typeof message.sender === "string" &&
    typeof message.subject === "string"
  ) {
    return {
      ...base,
      kind: "message",
      threadId: message.threadId as ThreadId,
      messageId: message.messageId as MessageId,
      sender: senderText(message.sender),
      subject: subjectText(message.subject),
    };
  }
  return null;
}

// The path comes only from checked ids, so nothing a sender wrote can choose where
// a click goes.
export function notificationFor(notice: PushNotice): ShownNotification {
  if (notice.kind === "summary") {
    return {
      title: `${notice.count} new messages`,
      body: "Open Mail to read them.",
      tag: `mailbox-${notice.mailboxId}`,
      path: `/${notice.mailboxId}/inbox`,
    };
  }
  return {
    title: notice.sender || "New message",
    body: notice.subject || "(No subject)",
    tag: `message-${notice.mailboxId}-${notice.messageId}`,
    path: `/${notice.mailboxId}/inbox/${notice.threadId}`,
  };
}
