import { safeFileName } from "@cloudysuite/transfer";
import type { Address } from "../types";
import { holdsSomethingAdded } from "./added";
import { NOTHING_PREFILLED } from "./types";
import type {
  DraftChange,
  DraftForEditor,
  DraftHolds,
  KeptDraft,
  KeptNote,
  LeftOut,
  OutgoingId,
  SaveResult,
} from "./types";
import { isHeld } from "./types";
import { isSession, parseOutgoingId } from "./wire";

const NOTHING_LEFT_OUT: LeftOut = { files: [], quote: false, reply: false };

export const isLeftOut = ({ files, quote, reply }: LeftOut): boolean =>
  files.length > 0 || quote || reply;

export const keptHoldsSomething = (draft: KeptDraft): boolean =>
  holdsSomethingAdded(
    {
      content: draft.content,
      uploads: draft.attachments.filter((file) => file.carriedFrom === null)
        .length,
    },
    draft.prefill,
  );

export function leftOutOf(
  had: Pick<DraftForEditor, "attachments" | "quote" | "parent" | "mode"> & {
    includeQuote: boolean;
  },
  holds: DraftHolds,
): LeftOut {
  return {
    files: had.attachments
      .filter((file) => !isHeld(file, holds))
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

export function leftOutText(
  { files, quote, reply }: LeftOut,
  lead = "This message was changed, sent, or removed somewhere else.",
): string {
  const missing = [
    ...(files.length === 1 ? [`the attached file ${namedFiles(files)}`] : []),
    ...(files.length > 1
      ? [`${files.length} attached files (${namedFiles(files)})`]
      : []),
    ...(quote ? ["the original message"] : []),
  ];
  const sentences = [
    lead,
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

const NEW_DRAFT_BESIDE =
  "while you were writing, so your words are in a new draft beside it.";

// `named` reads inside a sentence, such as "this draft" or a quoted subject.
export function changedText({ by }: DraftChange, named = "this draft"): string {
  const opening = `${named[0]!.toUpperCase()}${named.slice(1)}`;
  return by
    ? `${by} changed ${named} ${NEW_DRAFT_BESIDE}`
    : `${opening} was changed on another device or tab ${NEW_DRAFT_BESIDE}`;
}

// Nothing was saved, because nothing on this screen is new.
export const behindText = ({ by }: DraftChange): string =>
  `${by ? `${by} changed this draft` : "This draft was changed on another device or tab"} after you opened it, so what's here is the older version. Close this and open it again from Drafts to see the latest.`;

export const sentBesideText = ({ by }: DraftChange): string =>
  `${by ? `${by} changed the draft you opened` : "The draft you opened was changed on another device or tab"}, so your words are going from a new draft of their own. The other version is still in Drafts.`;

export const discardBehindText = ({ by }: DraftChange): string =>
  `${by ? `${by} changed this draft` : "This draft was changed on another device or tab"} after you opened it, so it's still in Drafts. What you had on this screen is gone.`;

// What a person is told about words that went to Drafts while they weren't looking.
export function keptNoteText({
  subject,
  leftOut,
  changed,
}: Pick<KeptNote, "subject" | "leftOut" | "changed">): string {
  if (!changed) return leftOutText(leftOut);
  const lead = changedText(changed, subject ? `"${subject}"` : "a draft");
  return isLeftOut(leftOut) ? leftOutText(leftOut, lead) : lead;
}

export async function moveToDrafts(
  draft: KeptDraft,
  save: () => Promise<SaveResult>,
): Promise<{
  savedAs: OutgoingId;
  leftOut: LeftOut;
  changed: DraftChange | null;
} | null> {
  if (!keptHoldsSomething(draft)) return null;
  const had = { ...draft, includeQuote: draft.content.includeQuote };
  const result = await save();
  if (result.status === "saved") {
    return {
      savedAs: draft.id,
      leftOut: leftOutOf(had, result.holds),
      changed: null,
    };
  }
  // Anything else but a copy means these words held nothing to keep.
  if (result.status !== "copied") return null;
  // A copy already sent means an earlier try got this far, and the words went with it.
  return result.state === "draft"
    ? {
        savedAs: result.id,
        leftOut: leftOutOf(had, result.holds),
        changed: result.changed,
      }
    : { savedAs: result.id, leftOut: NOTHING_LEFT_OUT, changed: null };
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
      typeof one.size === "number" &&
      (one.carriedFrom == null || typeof one.carriedFrom === "number"),
  );

// Another tab, an old version, or anything else on this origin may have written the
// row, so its shape is checked like a request's. The parts the editor reads as markup
// are cleaned where they enter it. A row from an earlier build recorded no prefill, file
// origins, or session. Without them everything counts as added, which can only keep its
// words, and its time stands in for its session, so a retry still reaches the same copy.
export function parseKeptDraft(raw: unknown): KeptDraft | null {
  if (!isRecord(raw) || !isRecord(raw.content)) return null;
  const { content, quote, parent, prefill } = raw;
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
    (raw.quoteHtml === null || isString(raw.quoteHtml)) &&
    (raw.session === undefined || isSession(raw.session)) &&
    (prefill === undefined ||
      (isRecord(prefill) &&
        arePeople(prefill.to) &&
        arePeople(prefill.cc) &&
        isString(prefill.subject)));
  if (!valid) return null;
  const draft = raw as KeptDraft;
  return {
    ...draft,
    session: draft.session ?? `kept-${draft.keptAt}`,
    written: draft.written !== false,
    prefill: draft.prefill ?? NOTHING_PREFILLED,
    attachments: draft.attachments.map((file) => ({
      ...file,
      carriedFrom: file.carriedFrom ?? null,
    })),
  };
}

export function parseKeptNote(raw: unknown): KeptNote | null {
  if (!isRecord(raw) || !isRecord(raw.leftOut)) return null;
  const { files, quote, reply } = raw.leftOut;
  const { changed } = raw;
  const valid =
    parseOutgoingId(raw.id) !== null &&
    isString(raw.mailboxId) &&
    isString(raw.subject) &&
    Array.isArray(files) &&
    files.every(isString) &&
    typeof quote === "boolean" &&
    typeof reply === "boolean" &&
    (changed === null ||
      (isRecord(changed) && (changed.by === null || isString(changed.by))));
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
