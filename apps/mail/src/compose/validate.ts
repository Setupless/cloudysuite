import type { Address } from "../types";
import {
  type DraftContent,
  fitsSendLimit,
  MAX_ATTACHMENTS,
  MAX_BODY_BYTES,
  MAX_RECIPIENTS,
  MAX_SUBJECT_LENGTH,
  TOO_LARGE_TEXT,
  TOO_MANY_ATTACHMENTS_TEXT,
} from "./types";

// A pasted line break must not start a new mail header, wherever the text came from.
export const singleLineText = (value: string) =>
  value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const cleanSubject = (subject: string) =>
  singleLineText(subject).slice(0, MAX_SUBJECT_LENGTH);

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

// Narrower than RFC 5321 on purpose: no quoted local parts, comments, or international
// local parts, and nothing that could end a header. Real mail addresses pass.
export function isValidAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0 || address.length > 254) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (
    !LOCAL_PART.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) {
    return false;
  }
  const labels = domain.split(".");
  return (
    labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label))
  );
}

// Reads what a person types or pastes into a To, Cc, or Bcc field:
//   a@x.org, Bo Lee <b@x.org>; "Lee, Cy" <c@x.org>
export function parseAddressList(input: string): Address[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let bracketed = false;
  for (const character of input) {
    if (character === '"') quoted = !quoted;
    if (!quoted && character === "<") bracketed = true;
    if (!quoted && character === ">") bracketed = false;
    if (!quoted && !bracketed && /[,;\n\r]/.test(character)) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);

  return parts.flatMap((part) => {
    const text = part.trim();
    if (!text) return [];
    const named = /^(.*)<([^<>]*)>$/s.exec(text);
    if (!named) return [{ name: "", address: text }];
    return [
      {
        name: singleLineText(named[1]!.replace(/^\s*"|"\s*$/g, "")),
        address: named[2]!.trim(),
      },
    ];
  });
}

export function allRecipients(content: DraftContent): Address[] {
  return [...content.to, ...content.cc, ...content.bcc];
}

// Someone listed twice gets one copy, and stays in the most visible field they were in.
export function withoutRepeatedRecipients(content: DraftContent): DraftContent {
  const seen = new Set<string>();
  const firstMentions = (people: Address[]) =>
    people.filter(({ address }) => {
      const key = address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    ...content,
    to: firstMentions(content.to),
    cc: firstMentions(content.cc),
    bcc: firstMentions(content.bcc),
  };
}

export type SendRefusal = { status: number; message: string };

const refuse = (status: number, message: string): SendRefusal => ({
  status,
  message,
});

// Everything Cloudflare would refuse that a person can fix, in words they can act on.
// The server decides with this, and the screen uses it to say so sooner.
export function refusalToSend(input: {
  content: DraftContent;
  plainText: string;
  bodyBytes: number;
  quoteBytes: number;
  attachmentSizes: number[];
}): SendRefusal | null {
  const { content, plainText, bodyBytes, quoteBytes, attachmentSizes } = input;
  const recipients = allRecipients(content);
  if (recipients.length === 0) {
    return refuse(400, "Add at least one person to send this to.");
  }
  const bad = recipients.find(({ address }) => !isValidAddress(address));
  if (bad) {
    return refuse(
      400,
      `"${singleLineText(bad.address).slice(0, 100)}" doesn't look like an email address. Fix it or remove it.`,
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return refuse(
      400,
      `A message can go to at most ${MAX_RECIPIENTS} people, counting To, Cc, and Bcc. This one has ${recipients.length}. Remove some, or send a second message.`,
    );
  }
  if (!cleanSubject(content.subject)) {
    return refuse(400, "Add a subject before you send this.");
  }
  if (attachmentSizes.length > MAX_ATTACHMENTS) {
    return refuse(400, TOO_MANY_ATTACHMENTS_TEXT);
  }
  if (bodyBytes > MAX_BODY_BYTES) {
    return refuse(
      413,
      "This message is too long to send. Move some of it into an attachment.",
    );
  }
  if (
    !plainText.trim() &&
    !content.includeQuote &&
    attachmentSizes.length === 0
  ) {
    return refuse(
      400,
      "This message is empty. Write something or attach a file.",
    );
  }
  if (!fitsSendLimit({ bodyBytes, quoteBytes, attachmentSizes })) {
    return refuse(413, TOO_LARGE_TEXT);
  }
  return null;
}
