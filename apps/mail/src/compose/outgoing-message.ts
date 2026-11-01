import { Buffer } from "node:buffer";
import type { Address } from "../types";
import {
  ownReferenceId,
  storedMessageId,
  type ThreadingHeaders,
  threadingHeaders,
} from "./threading-headers";
import type { OutgoingId, ParentFacts } from "./types";
import { cleanSubject, singleLineText } from "./validate";

export type OutgoingFile = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type OutgoingMessage = {
  id: OutgoingId;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  text: string;
  parent: Pick<ParentFacts, "rfcMessageId" | "references"> | null;
  files: OutgoingFile[];
};

const headersFor = (message: OutgoingMessage): ThreadingHeaders =>
  threadingHeaders(
    message.parent,
    ownReferenceId(message.id, message.from.address),
  );

const person = ({ name, address }: Address) => {
  const clean = singleLineText(name);
  return clean ? { name: clean, email: address } : address;
};

const people = (list: Address[]) => list.map(person);

// Empty lists stay out, because the API wants at least one recipient field and treats
// an empty one as a mistake. Each attachment goes as base64 text. That is the form both
// the real service and the local one accept. The service wants text or HTML even when
// a message is only its attachments, and HTML can't be trimmed away to nothing.
export function toEmailBuilder(message: OutgoingMessage): EmailMessageBuilder {
  const recipients = {
    ...(message.to.length ? { to: people(message.to) } : {}),
    ...(message.cc.length ? { cc: people(message.cc) } : {}),
    ...(message.bcc.length ? { bcc: people(message.bcc) } : {}),
  } as EmailMessageBuilder;
  return {
    ...recipients,
    from: person(message.from),
    subject: cleanSubject(message.subject),
    ...(message.text ? { text: message.text } : {}),
    ...(message.html ? { html: message.html } : {}),
    ...(message.text || message.html.trim() ? {} : { html: "<br>" }),
    headers: headersFor(message),
    ...(message.files.length
      ? {
          attachments: message.files.map((file) => ({
            content: Buffer.from(file.bytes).toString("base64"),
            filename: file.filename,
            type: file.mimeType,
            disposition: "attachment" as const,
          })),
        }
      : {}),
  };
}

const CRLF = "\r\n";

const isPlainAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

// Splits on whole characters, so no encoded word ends inside one.
function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (Buffer.byteLength(chunk + character) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`)
    .join(`${CRLF} `);
}

const headerText = (text: string) =>
  isPlainAscii(text) ? text : encodedWords(text);

function formatPerson({ name, address }: Address): string {
  const clean = singleLineText(name);
  if (!clean) return address;
  if (!isPlainAscii(clean)) return `${encodedWords(clean)} <${address}>`;
  return `"${clean.replace(/["\\]/g, "\\$&")}" <${address}>`;
}

const formatPeople = (list: Address[]) =>
  list.map(formatPerson).join(`,${CRLF} `);

function base64Lines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let start = 0; start < encoded.length; start += 76) {
    lines.push(encoded.slice(start, start + 76));
  }
  return lines.join(CRLF);
}

const textPart = (type: "plain" | "html", content: string) =>
  [
    `Content-Type: text/${type}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(new TextEncoder().encode(content)),
  ].join(CRLF);

function filePart(file: OutgoingFile): string {
  const name = singleLineText(file.filename).replace(/["\\]/g, "_");
  const safeName = isPlainAscii(name) ? name : encodedWords(name);
  return [
    `Content-Type: ${file.mimeType}; name="${safeName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${safeName}"`,
    "",
    base64Lines(file.bytes),
  ].join(CRLF);
}

const multipart = (subtype: string, boundary: string, parts: string[]) =>
  [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"`,
    "",
    ...parts.flatMap((part) => [`--${boundary}`, part]),
    `--${boundary}--`,
    "",
  ].join(CRLF);

// Our own record of what went out, stored through `ingest` like any other message and
// offered as "Download the original". It is the only place Bcc is ever written down.
export function storedCopyRaw(
  message: OutgoingMessage,
  returnedMessageId: unknown,
  sentAt: number,
): ArrayBuffer {
  const ownId = ownReferenceId(message.id, message.from.address);
  const headers = headersFor(message);
  const body = multipart("alternative", `alt-${message.id}`, [
    textPart("plain", message.text),
    textPart("html", message.html),
  ]);
  const content = message.files.length
    ? multipart("mixed", `mixed-${message.id}`, [
        body,
        ...message.files.map(filePart),
      ])
    : body;
  const lines = [
    `From: ${formatPerson(message.from)}`,
    ...(message.to.length ? [`To: ${formatPeople(message.to)}`] : []),
    ...(message.cc.length ? [`Cc: ${formatPeople(message.cc)}`] : []),
    ...(message.bcc.length ? [`Bcc: ${formatPeople(message.bcc)}`] : []),
    `Subject: ${headerText(cleanSubject(message.subject))}`,
    `Date: ${new Date(sentAt).toUTCString()}`,
    `Message-ID: <${storedMessageId(returnedMessageId, ownId)}>`,
    ...(headers["In-Reply-To"]
      ? [`In-Reply-To: ${headers["In-Reply-To"]}`]
      : []),
    `References: ${headers.References}`,
    "MIME-Version: 1.0",
    content,
  ];
  return new TextEncoder().encode(lines.join(CRLF)).buffer as ArrayBuffer;
}
