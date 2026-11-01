import PostalMime, {
  addressParser,
  decodeWords,
  type Address as ParsedAddress,
  type Attachment,
} from "postal-mime";
import { parseReferences, parseMessageIds } from "./threading";
import {
  type Address,
  BODY_INLINE_LIMIT_BYTES,
  type ParseStatus,
} from "./types";

// Well below postal-mime's defaults, which allow far more than real mail uses.
// A message over a limit is still stored and shown, by the fallback below.
export const PARSE_LIMITS = {
  maxNestingDepth: 32,
  maxHeadersSize: 256 * 1024,
  maxPartCount: 500,
  maxRfc822NestingDepth: 5,
  maxForwardedAddresses: 1000,
} as const;

const MAX_ADDRESSES_PER_FIELD = 500;
const MAX_SUBJECT_LENGTH = 998;
const MAX_FILENAME_LENGTH = 255;
const SNIPPET_LENGTH = 200;
const FALLBACK_HEADER_BYTES = 64 * 1024;
const MAX_HTML_FOR_TEXT = 4 * 1024 * 1024;

export type ParsedAttachment = {
  filename: string | null;
  mimeType: string;
  inline: boolean;
  contentId: string | null;
  content: ArrayBuffer | Uint8Array;
};

export type ParsedMessage = {
  status: ParseStatus;
  rfcMessageId: string | null;
  references: string[];
  subject: string | null;
  from: Address | null;
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  sentAt: number | null;
  firstAuthenticationResults: string | null;
  text: string | null;
  html: string | null;
  attachments: ParsedAttachment[];
};

// A subject or name shows on one line, and a later reply copies it into a header.
const singleLine = (value: string) => value.replace(/\p{Cc}+/gu, " ").trim();

function flatten(addresses: ParsedAddress[] | undefined): Address[] {
  const flat: Address[] = [];
  for (const entry of addresses ?? []) {
    for (const person of entry.group ?? [entry]) {
      if (person.address) {
        flat.push({
          name: singleLine(person.name ?? ""),
          address: person.address,
        });
      }
    }
  }
  return flat.slice(0, MAX_ADDRESSES_PER_FIELD);
}

const cleanSubject = (subject: string | null | undefined) =>
  subject ? singleLine(subject).slice(0, MAX_SUBJECT_LENGTH) : null;

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

const STRIPPED_FROM_FILENAME = /[\p{Cc}"']/gu;
const UNSAFE_FILENAME = /[‪-‮⁦-⁩/\\]/gu;

function cleanFilename(filename: string | null): string | null {
  if (!filename) return null;
  const clean = filename
    .replace(STRIPPED_FROM_FILENAME, "")
    .replace(UNSAFE_FILENAME, "_")
    .slice(0, MAX_FILENAME_LENGTH);
  return clean || null;
}

const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

function cleanMimeType(mimeType: string): string {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  return MIME_TYPE.test(type) ? type : "application/octet-stream";
}

function cleanContentId(contentId: string | undefined): string | null {
  if (!contentId) return null;
  const id = contentId.trim().replace(/^<|>$/g, "");
  return id && id.length <= 255 && !/\s/.test(id) ? id : null;
}

function toParsedAttachment(attachment: Attachment): ParsedAttachment {
  const { content } = attachment;
  return {
    filename: cleanFilename(attachment.filename),
    mimeType: cleanMimeType(attachment.mimeType),
    inline: attachment.related === true || attachment.disposition === "inline",
    contentId: cleanContentId(attachment.contentId),
    content:
      typeof content === "string" ? new TextEncoder().encode(content) : content,
  };
}

async function parseWithPostalMime(raw: ArrayBuffer): Promise<ParsedMessage> {
  const email = await PostalMime.parse(raw, {
    ...PARSE_LIMITS,
    attachmentEncoding: "arraybuffer",
  });
  return {
    status: "parsed",
    rfcMessageId: parseMessageIds(email.messageId)[0] ?? null,
    references: parseReferences(email.references, email.inReplyTo),
    subject: cleanSubject(email.subject),
    from: flatten(email.from ? [email.from] : [])[0] ?? null,
    replyTo: flatten(email.replyTo),
    to: flatten(email.to),
    cc: flatten(email.cc),
    sentAt: parseDate(email.date),
    firstAuthenticationResults:
      email.headers.find((header) => header.key === "authentication-results")
        ?.value ?? null,
    text: email.text ?? null,
    html: email.html ?? null,
    attachments: email.attachments.map(toParsedAttachment),
  };
}

function readHeaders(head: string): Map<string, string> {
  const headers = new Map<string, string>();
  let current: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (line === "") break;
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) break;
    const name = line.slice(0, colon).trim().toLowerCase();
    current = headers.has(name) ? null : name;
    if (current) headers.set(current, line.slice(colon + 1).trim());
  }
  return headers;
}

function bodyStart(head: string): number {
  const match = /\r?\n\r?\n/.exec(head);
  return match ? match.index + match[0].length : 0;
}

function safeAddresses(value: string | undefined): Address[] {
  if (!value) return [];
  try {
    return flatten(addressParser(value));
  } catch {
    return [];
  }
}

function safeDecodeWords(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeWords(value);
  } catch {
    return value;
  }
}

// Reads what it can from the raw bytes when the parser gives up, so that a
// hostile message still appears, with its sender, subject, and readable text.
function parseFallback(raw: ArrayBuffer): ParsedMessage {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const headBytes = raw.slice(0, FALLBACK_HEADER_BYTES);
  const headers = readHeaders(decoder.decode(headBytes));
  // A single-byte decoding, so that a character offset is also a byte offset.
  const start = bodyStart(new TextDecoder("latin1").decode(headBytes));
  const text = decoder.decode(
    raw.slice(start, start + BODY_INLINE_LIMIT_BYTES),
  );
  return {
    status: "failed",
    rfcMessageId: parseMessageIds(headers.get("message-id"))[0] ?? null,
    references: parseReferences(
      headers.get("references"),
      headers.get("in-reply-to"),
    ),
    subject: cleanSubject(safeDecodeWords(headers.get("subject"))),
    from: safeAddresses(headers.get("from"))[0] ?? null,
    replyTo: safeAddresses(headers.get("reply-to")),
    to: safeAddresses(headers.get("to")),
    cc: safeAddresses(headers.get("cc")),
    sentAt: parseDate(headers.get("date")),
    firstAuthenticationResults: headers.get("authentication-results") ?? null,
    text: text || null,
    html: null,
    attachments: [],
  };
}

export async function parseMessage(raw: ArrayBuffer): Promise<ParsedMessage> {
  try {
    return await parseWithPostalMime(raw);
  } catch {
    return parseFallback(raw);
  }
}

const SKIPPED_ELEMENTS = ["script", "style", "head", "title"];

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi,
    (match, decimal, hex, name) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? match;
      const code = decimal ? Number(decimal) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );
}

// Only for the snippet and search index of a message with no text part. It makes
// one forward pass, because a regular expression over hostile markup, such as
// thousands of unclosed tags, can take quadratic time.
export function htmlToSearchText(html: string): string {
  const source = html.slice(0, MAX_HTML_FOR_TEXT);
  const lower = source.toLowerCase();
  let output = "";
  let position = 0;
  while (position < source.length) {
    const open = source.indexOf("<", position);
    if (open === -1) {
      output += source.slice(position);
      break;
    }
    output += source.slice(position, open);
    const close = source.indexOf(">", open);
    if (close === -1) break;
    const skipped = SKIPPED_ELEMENTS.find(
      (name) =>
        lower.startsWith(name, open + 1) &&
        !/[a-z0-9-]/.test(lower[open + 1 + name.length] ?? ""),
    );
    if (skipped) {
      const end = lower.indexOf(`</${skipped}`, close);
      if (end === -1) break;
      position = lower.indexOf(">", end) + 1;
      if (position === 0) break;
    } else {
      position = close + 1;
    }
    output += " ";
  }
  return decodeEntities(output);
}

export function readableText(message: {
  text: string | null;
  html: string | null;
}): string {
  const text =
    message.text ?? (message.html ? htmlToSearchText(message.html) : "");
  return text.replaceAll("\u0000", "");
}

export function snippetOf(text: string): string {
  return text
    .slice(0, SNIPPET_LENGTH * 20)
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
    .slice(0, SNIPPET_LENGTH);
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes) return text;
  const buffer = new Uint8Array(maxBytes);
  const { read } = new TextEncoder().encodeInto(text, buffer);
  return text.slice(0, read);
}
