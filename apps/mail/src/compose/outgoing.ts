import type { MailboxId } from "@cloudysuite/access";
import type { Mailbox } from "../mailbox";
import { cleanFileName, cleanMimeType } from "../parse";
import {
  attachmentUploadKey,
  forwardedAttachmentKey,
  outgoingPrefix,
  quoteHtmlKey,
  quoteTextKey,
} from "../r2-keys";
import type {
  AttachmentInfo,
  MessageBody,
  MessageDetail,
  MessageId,
} from "../types";
import { holdsSomethingAdded } from "./added";
import { copyIdOf } from "./copy-id";
import type {
  AddAttachmentResult,
  CopyCarry,
  NewFile,
  NewOutgoing,
  ScheduleResult,
  StoredSave,
} from "./store";
import { buildQuote, cleanEditorHtml, htmlToPlainText } from "./body";
import { composeSubject, defaultFromAddress, replyRecipients } from "./reply";
import {
  type ComposeMode,
  type DiscardResult,
  type DraftBase,
  type DraftContent,
  type DraftForEditor,
  type DraftStart,
  type Editor,
  fitsSendLimit,
  MAX_ATTACHMENTS,
  NOTHING_PREFILLED,
  type OutgoingDetail,
  type OutgoingId,
  type OutgoingSummary,
  type RemoveAttachmentResult,
  SEND_FAILURES,
  type SaveIntent,
  type SaveResult,
  TOO_LARGE_TEXT,
  TOO_MANY_ATTACHMENTS_TEXT,
} from "./types";
import {
  cleanSubject,
  refusalToSend,
  type SendRefusal,
  withoutRepeatedRecipients,
} from "./validate";
import type { Address } from "../types";

// Everything a reply or forward opens with comes from here, read fresh from the message
// it answers. It writes nothing, so opening a reply and leaving costs nothing.
export type ReplySource = {
  mode: Exclude<ComposeMode, "new">;
  parent: MessageDetail;
  body: MessageBody;
  inlineAttachments: {
    info: AttachmentInfo;
    read: () => Promise<ArrayBuffer | null>;
  }[];
  ownAddresses: readonly string[];
  ownDomain: string;
};

export type PrefilledDraft = {
  draft: DraftForEditor;
  quoteHtml: string;
  // Something a person should know about what came along.
  notice: string | null;
};

// The first save of a reply: where the row's quote and files come from, and which of
// them the person kept.
export type NewRowFrom = { source: ReplySource; start: DraftStart };

export type AttachmentBody = {
  declaredBytes: number | null;
  read: (limit: number) => Promise<ArrayBuffer | null>;
};

export type MailboxOutgoing = {
  list(viewerId: string): Promise<OutgoingSummary[]>;
  detail(id: OutgoingId, viewerId: string): Promise<OutgoingDetail | null>;
  quoteHtml(id: OutgoingId): Promise<string | null>;
  suggest(query: string): Promise<Address[]>;
  prefill(source: ReplySource): Promise<PrefilledDraft>;
  save(
    input: SaveIntent & {
      id: OutgoingId;
      content: DraftContent;
      editor: Editor;
      ownDomain: string;
      from?: NewRowFrom;
      leaving?: boolean;
    },
  ): Promise<SaveResult>;
  send(
    input: DraftBase & {
      id: OutgoingId;
      content: DraftContent;
      editor: Editor;
      ownDomain: string;
      fromName: string;
      from?: NewRowFrom;
    },
  ): Promise<ScheduleResult | { status: "refused"; refusal: SendRefusal }>;
  undo(id: OutgoingId): Promise<boolean>;
  reopen(id: OutgoingId): Promise<boolean>;
  discard(
    input: DraftBase & { id: OutgoingId; editor: Editor },
  ): Promise<DiscardResult>;
  upload(
    input: DraftBase & {
      id: OutgoingId;
      fileName: string;
      mimeType: string;
      body: AttachmentBody;
      fromAddress: string;
      editor: Editor;
      from?: NewRowFrom;
    },
  ): Promise<AddAttachmentResult>;
  removeAttachment(
    input: DraftBase & {
      id: OutgoingId;
      attachmentId: number;
      editor: Editor;
    },
  ): Promise<RemoveAttachmentResult>;
};

const NOTHING_CARRIED = {
  attachmentIds: [],
  carriedFrom: [],
  quote: false,
  threaded: false,
};

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

async function readPrefill(source: ReplySource) {
  const { mode, parent, body, ownAddresses, ownDomain } = source;
  const recipients = replyRecipients(parent, mode, ownAddresses);
  const subject = composeSubject(parent.subject, mode);
  const carried = mode === "forward" ? source.inlineAttachments : [];
  const quote = await buildQuote(parent, body, mode, ownDomain);
  return {
    quote,
    quoteBytes: byteLength(quote.html) + byteLength(quote.text),
    files: carried.slice(0, MAX_ATTACHMENTS),
    cutShort: carried.length > MAX_ATTACHMENTS,
    prefill: { ...recipients, subject },
    content: {
      from: defaultFromAddress(parent, ownAddresses),
      ...recipients,
      bcc: [],
      subject,
      html: "",
      includeQuote: true,
    } satisfies DraftContent,
    parentFacts: {
      messageId: parent.id as MessageId,
      rfcMessageId: parent.rfcMessageId,
      references: parent.references,
    },
  };
}

// Runs in the Worker, so that file bytes never pass through the Durable Object and hold
// up everyone else using the mailbox. The object only keeps the records.
export function createMailboxOutgoing(
  bucket: R2Bucket,
  stub: DurableObjectStub<Mailbox>,
  mailboxId: MailboxId,
): MailboxOutgoing {
  const prefixOf = (id: OutgoingId) => outgoingPrefix(mailboxId, id);
  const detailOf = async (id: OutgoingId, viewerId: string) =>
    (await stub.outgoingDetail(id, viewerId)) as OutgoingDetail | null;

  const chosenFiles = (
    files: ReplySource["inlineAttachments"],
    start: DraftStart,
  ) => files.filter(({ info }) => start.carried.includes(info.id));

  // Safe to repeat: the id comes from the browser, and each file has a fixed key.
  const writeNewRowFiles = async (
    id: OutgoingId,
    prefilled: Awaited<ReturnType<typeof readPrefill>>,
    { source, start }: NewRowFrom,
    editor: Editor,
  ): Promise<NewOutgoing> => {
    const prefix = prefixOf(id);
    const { quote, files } = prefilled;
    await Promise.all([
      bucket.put(quoteHtmlKey(prefix), new TextEncoder().encode(quote.html)),
      bucket.put(quoteTextKey(prefix), new TextEncoder().encode(quote.text)),
    ]);
    const attachments: NewOutgoing["attachments"] = [];
    for (const [index, file] of files.entries()) {
      if (!start.carried.includes(file.info.id)) continue;
      const bytes = await file.read();
      if (!bytes) continue;
      const r2Key = forwardedAttachmentKey(prefix, index);
      await bucket.put(r2Key, bytes);
      attachments.push({
        filename: cleanFileName(file.info.filename) ?? "Attachment",
        mimeType: file.info.mimeType,
        size: bytes.byteLength,
        r2Key,
        carriedFrom: file.info.id,
      });
    }
    return {
      id,
      mode: source.mode,
      parent: prefilled.parentFacts,
      prefill: prefilled.prefill,
      content: { ...prefilled.content, includeQuote: start.includeQuote },
      r2Prefix: prefix,
      quote: { bytes: prefilled.quoteBytes, designed: quote.designed },
      attachments,
      editor,
    };
  };

  // A row's quote and files are written only once its first save holds something added.
  const newRow = async (
    id: OutgoingId,
    content: DraftContent,
    from: NewRowFrom | undefined,
    editor: Editor,
  ): Promise<NewOutgoing | "nothing" | undefined> => {
    if (!from || (await detailOf(id, editor.id))) return undefined;
    const prefilled = await readPrefill(from.source);
    const added = holdsSomethingAdded(
      { content, uploads: 0 },
      prefilled.prefill,
    );
    return added ? writeNewRowFiles(id, prefilled, from, editor) : "nothing";
  };

  const cleanContent = async (
    content: DraftContent,
    ownDomain: string,
  ): Promise<{ content: DraftContent; plainText: string }> => {
    const html = await cleanEditorHtml(content.html, ownDomain);
    return {
      content: { ...content, html, subject: cleanSubject(content.subject) },
      plainText: htmlToPlainText(html),
    };
  };

  // The words are already safe in the new draft, so a file that can't be read just stays
  // out of it, and what comes back tells the person so.
  const carryOver = async (id: OutgoingId, carry: CopyCarry) => {
    const quote = await copyQuote(carry);
    const files: NewFile[] = [];
    for (const file of carry.files) {
      const r2Key = attachmentUploadKey(carry.toPrefix, crypto.randomUUID());
      if (await copyObject(file.r2_key, r2Key)) {
        files.push({ ...file, r2_key: r2Key });
      }
    }
    const held = await stub.carryIntoOutgoingCopy(id, { quote, files });
    return held ?? { holds: NOTHING_CARRIED, files: [] };
  };

  const copyObject = async (from: string, to: string): Promise<boolean> => {
    try {
      const object = await bucket.get(from);
      if (!object) return false;
      await bucket.put(to, await object.arrayBuffer());
      return true;
    } catch (error) {
      console.error("A file couldn't be copied to a new draft.", error);
      return false;
    }
  };

  const copyQuote = async ({ quote, fromPrefix, toPrefix }: CopyCarry) => {
    if (!quote) return null;
    const copied = await Promise.all(
      [quoteHtmlKey, quoteTextKey].map((key) =>
        copyObject(key(fromPrefix), key(toPrefix)),
      ),
    );
    return copied.every(Boolean) ? quote : null;
  };

  return {
    list: async (viewerId) =>
      (await stub.listOutgoing(viewerId)) as OutgoingSummary[],
    detail: detailOf,
    suggest: async (query) => (await stub.suggestAddresses(query)) as Address[],

    async quoteHtml(id) {
      return (
        (await (await bucket.get(quoteHtmlKey(prefixOf(id))))?.text()) ?? null
      );
    },

    async prefill(source) {
      const prefilled = await readPrefill(source);
      return {
        draft: {
          content: prefilled.content,
          revision: 0,
          mode: source.mode,
          parent: prefilled.parentFacts,
          prefill: prefilled.prefill,
          quote: {
            bytes: prefilled.quoteBytes,
            designed: prefilled.quote.designed,
          },
          attachments: prefilled.files.map(({ info }) => ({
            id: info.id,
            filename: cleanFileName(info.filename) ?? "Attachment",
            mimeType: info.mimeType,
            size: info.size,
            carriedFrom: info.id,
          })),
        },
        quoteHtml: prefilled.quote.html,
        notice: prefilled.cutShort
          ? `Only the first ${MAX_ATTACHMENTS} files came along, because a message can't have more.`
          : null,
      };
    },

    async save({ content, ownDomain, from, ...save }) {
      const { id, editor } = save;
      const clean = await cleanContent(content, ownDomain);
      const create = await newRow(id, clean.content, from, editor);
      if (create === "nothing") return { status: "nothing" };
      const result = (await stub.saveOutgoing({
        ...save,
        ...clean,
        copyId: await copyIdOf(id, save.session),
        mailboxId,
        r2Prefix: prefixOf(id),
        create,
      })) as StoredSave;
      if (result.status !== "copied") return result;
      const { carry, ...copied } = result;
      return carry
        ? { ...copied, ...(await carryOver(copied.id, carry)) }
        : copied;
    },

    async send({
      id,
      baseRevision,
      session,
      content,
      editor,
      ownDomain,
      fromName,
      from,
    }) {
      const cleaned = await cleanContent(content, ownDomain);
      const clean = {
        ...cleaned,
        content: withoutRepeatedRecipients(cleaned.content),
      };
      const current = await detailOf(id, editor.id);
      const prefilled =
        !current && from ? await readPrefill(from.source) : null;
      const chosen = prefilled ? chosenFiles(prefilled.files, from!.start) : [];
      const attachmentSizes = current
        ? current.attachments.map((file) => file.size)
        : chosen.map(({ info }) => info.size);
      const refusal = refusalToSend({
        content: clean.content,
        plainText: clean.plainText,
        addedNothing: !holdsSomethingAdded(
          {
            content: clean.content,
            uploads:
              current?.attachments.filter((file) => file.carriedFrom === null)
                .length ?? 0,
          },
          current?.prefill ?? prefilled?.prefill ?? NOTHING_PREFILLED,
        ),
        bodyBytes: byteLength(clean.content.html),
        quoteBytes: !clean.content.includeQuote
          ? 0
          : (current?.quote?.bytes ?? prefilled?.quoteBytes ?? 0),
        attachmentSizes,
      });
      if (refusal && current?.state !== "scheduled") {
        return { status: "refused", refusal };
      }
      const create = prefilled
        ? await writeNewRowFiles(id, prefilled, from!, editor)
        : undefined;
      if (create && create.attachments.length < chosen.length) {
        return {
          status: "refused",
          refusal: { status: 409, message: SEND_FAILURES.attachmentMissing },
        };
      }
      return (await stub.scheduleOutgoing({
        id,
        baseRevision,
        session,
        ...clean,
        editor,
        r2Prefix: prefixOf(id),
        fromName,
        mailboxId,
        create,
      })) as ScheduleResult;
    },

    undo: (id) => stub.undoOutgoing(id),
    reopen: (id) => stub.reopenOutgoing(id),
    discard: (input) => stub.discardOutgoing(input),

    async upload({
      id,
      baseRevision,
      session,
      fileName,
      mimeType,
      body,
      fromAddress,
      editor,
      from,
    }) {
      if (body.declaredBytes === null) {
        return {
          status: "refused",
          httpStatus: 411,
          message:
            "We need to know the size of this file. Try attaching it again.",
        };
      }
      if (body.declaredBytes === 0) {
        return {
          status: "refused",
          httpStatus: 400,
          message: "This file is empty, so there is nothing to attach.",
        };
      }
      // Refused before a byte is read. The record's transaction checks the whole message.
      const alone = { bodyBytes: 0, quoteBytes: 0 };
      if (!fitsSendLimit({ ...alone, attachmentSizes: [body.declaredBytes] })) {
        return { status: "refused", httpStatus: 413, message: TOO_LARGE_TEXT };
      }
      // Checked here so that a file about to be refused doesn't copy the original's.
      const prefilled =
        from && !(await detailOf(id, editor.id))
          ? await readPrefill(from.source)
          : null;
      if (prefilled) {
        const carriedSizes = chosenFiles(prefilled.files, from!.start).map(
          ({ info }) => info.size,
        );
        if (carriedSizes.length >= MAX_ATTACHMENTS) {
          return {
            status: "refused",
            httpStatus: 400,
            message: TOO_MANY_ATTACHMENTS_TEXT,
          };
        }
        const fits = fitsSendLimit({
          bodyBytes: 0,
          quoteBytes: from!.start.includeQuote ? prefilled.quoteBytes : 0,
          attachmentSizes: [...carriedSizes, body.declaredBytes],
        });
        if (!fits) {
          return {
            status: "refused",
            httpStatus: 413,
            message: TOO_LARGE_TEXT,
          };
        }
      }
      const bytes = await body.read(body.declaredBytes);
      if (bytes?.byteLength !== body.declaredBytes) {
        return {
          status: "refused",
          httpStatus: 400,
          message: "This file didn't arrive whole. Try attaching it again.",
        };
      }
      const prefix = prefixOf(id);
      const r2Key = attachmentUploadKey(prefix, crypto.randomUUID());
      await bucket.put(r2Key, bytes);
      const create = prefilled
        ? await writeNewRowFiles(id, prefilled, from!, editor)
        : undefined;
      const result = (await stub.addOutgoingAttachment({
        id,
        baseRevision,
        session,
        filename: cleanFileName(fileName) ?? "Attachment",
        mimeType: cleanMimeType(mimeType),
        size: bytes.byteLength,
        r2Key,
        editor,
        r2Prefix: prefix,
        fromAddress,
        create,
      })) as AddAttachmentResult;
      if (result.status !== "added") await bucket.delete([r2Key]);
      return result;
    },

    removeAttachment: (input) => stub.removeOutgoingAttachment(input),
  };
}
