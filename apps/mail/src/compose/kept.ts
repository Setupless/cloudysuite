import { safeFileName } from "../attachment-headers";
import type { Address } from "../types";
import type {
  DraftForEditor,
  DraftHolds,
  KeptDraft,
  KeptNote,
  LeftOut,
  OutgoingId,
  SaveResult,
} from "./types";
import { parseOutgoingId } from "./wire";

const NOTHING_LEFT_OUT: LeftOut = { files: [], quote: false, reply: false };
const HOLDS_NOTHING: DraftHolds = {
  attachmentIds: [],
  quote: false,
  threaded: false,
};

export const isLeftOut = ({ files, quote, reply }: LeftOut): boolean =>
  files.length > 0 || quote || reply;

export function leftOutOf(
  had: Pick<DraftForEditor, "attachments" | "quote" | "parent" | "mode"> & {
    includeQuote: boolean;
  },
  holds: DraftHolds,
): LeftOut {
  return {
    files: had.attachments
      .filter((file) => !holds.attachmentIds.includes(file.id))
      .map((file) => file.filename),
    quote: had.includeQuote && had.quote !== null && !holds.quote,
    reply: had.mode !== "forward" && had.parent !== null && !holds.threaded,
  };
}

const NAMED_FILES = 5;

function namedFiles(files: string[]): string {
  const names = files.slice(0, NAMED_FILES).map((name) => {
    return safeFileName(name, "Attachment");
  });
  const more = files.length - names.length;
  return `${names.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

export function leftOutText({ files, quote, reply }: LeftOut): string {
  const missing = [
    ...(files.length === 1 ? [`the attached file ${namedFiles(files)}`] : []),
    ...(files.length > 1
      ? [`${files.length} attached files (${namedFiles(files)})`]
      : []),
    ...(quote ? ["the original message"] : []),
  ];
  const sentences = [
    "This message was changed, sent, or removed somewhere else.",
    missing.length > 0
      ? `Your words are safe, but ${missing.join(" and ")} couldn't stay with them.`
      : "Your words are safe.",
    ...(files.length === 1
      ? ["Attach the file again if you still need it."]
      : []),
    ...(files.length > 1
      ? ["Attach the files again if you still need them."]
      : []),
    ...(quote
      ? ["Copy anything you still need from the original message."]
      : []),
    ...(reply ? ["This will go as a new message, not as a reply."] : []),
  ];
  return sentences.join(" ");
}

// The same words kept at the same moment always get the same new draft, so a retry, or
// a second tab doing the same work, can't make two of them.
export async function lockedCopyId(
  id: OutgoingId,
  keptAt: number,
): Promise<OutgoingId> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${id}:${keptAt}`),
  );
  const hex = Array.from(new Uint8Array(digest).subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-") as OutgoingId;
}

// Someone may have sent this message while the words were stuck here. The words still
// matter, and a sent message can't change, so they become a draft of their own.
export async function moveToDrafts(
  draft: KeptDraft,
  save: (id: OutgoingId) => Promise<SaveResult>,
): Promise<{ savedAs: OutgoingId; leftOut: LeftOut }> {
  const had = { ...draft, includeQuote: draft.content.includeQuote };
  const saved = await save(draft.id);
  if (saved.status === "saved") {
    return { savedAs: draft.id, leftOut: leftOutOf(had, saved.holds) };
  }
  const id = await lockedCopyId(draft.id, draft.keptAt);
  const copy = await save(id);
  return {
    savedAs: id,
    // A copy already sent means an earlier try got this far, and the words went with it.
    leftOut:
      copy.status === "saved"
        ? leftOutOf(had, HOLDS_NOTHING)
        : NOTHING_LEFT_OUT,
  };
}

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null;

const isString = (raw: unknown): raw is string => typeof raw === "string";

const arePeople = (raw: unknown): raw is Address[] =>
  Array.isArray(raw) &&
  raw.every(
    (one) => isRecord(one) && isString(one.name) && isString(one.address),
  );

const areFiles = (raw: unknown): raw is KeptDraft["attachments"] =>
  Array.isArray(raw) &&
  raw.every(
    (one) =>
      isRecord(one) &&
      typeof one.id === "number" &&
      isString(one.filename) &&
      isString(one.mimeType) &&
      typeof one.size === "number",
  );

// Another tab, an old version, or anything else on this origin may have written the
// row, so its shape is checked like a request's. The parts the editor reads as markup
// are cleaned where they enter it.
export function parseKeptDraft(raw: unknown): KeptDraft | null {
  if (!isRecord(raw) || !isRecord(raw.content)) return null;
  const { content, quote, parent } = raw;
  const valid =
    parseOutgoingId(raw.id) !== null &&
    isString(raw.mailboxId) &&
    typeof raw.keptAt === "number" &&
    typeof raw.revision === "number" &&
    ["new", "reply", "replyAll", "forward"].includes(raw.mode as string) &&
    isString(content.from) &&
    arePeople(content.to) &&
    arePeople(content.cc) &&
    arePeople(content.bcc) &&
    isString(content.subject) &&
    isString(content.html) &&
    typeof content.includeQuote === "boolean" &&
    areFiles(raw.attachments) &&
    (quote === null ||
      (isRecord(quote) &&
        typeof quote.bytes === "number" &&
        typeof quote.designed === "boolean")) &&
    (parent === null ||
      (isRecord(parent) &&
        typeof parent.messageId === "number" &&
        (parent.rfcMessageId === null || isString(parent.rfcMessageId)) &&
        Array.isArray(parent.references) &&
        parent.references.every(isString))) &&
    (raw.quoteHtml === null || isString(raw.quoteHtml));
  return valid ? (raw as KeptDraft) : null;
}

export function parseKeptNote(raw: unknown): KeptNote | null {
  if (!isRecord(raw) || !isRecord(raw.leftOut)) return null;
  const { files, quote, reply } = raw.leftOut;
  const valid =
    parseOutgoingId(raw.id) !== null &&
    isString(raw.mailboxId) &&
    isString(raw.subject) &&
    Array.isArray(files) &&
    files.every(isString) &&
    typeof quote === "boolean" &&
    typeof reply === "boolean";
  return valid ? (raw as KeptNote) : null;
}

export const withoutAccess = (
  kept: KeptDraft[],
  mailboxes: readonly { id: string }[] | undefined,
): KeptDraft[] =>
  mailboxes
    ? kept.filter(
        (draft) => !mailboxes.some((one) => one.id === draft.mailboxId),
      )
    : [];

export const keptAsText = ({ content }: KeptDraft, body: string): string => {
  const people = (list: Address[]) =>
    list.map(({ address }) => address).join(", ");
  return [
    ...(content.to.length > 0 ? [`To: ${people(content.to)}`] : []),
    ...(content.cc.length > 0 ? [`Cc: ${people(content.cc)}`] : []),
    ...(content.bcc.length > 0 ? [`Bcc: ${people(content.bcc)}`] : []),
    ...(content.subject ? [`Subject: ${content.subject}`] : []),
    "",
    body,
  ]
    .join("\n")
    .trim();
};
