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
import type { AddAttachmentResult, NewOutgoing, ScheduleResult } from "./store";
import { buildQuote, cleanEditorHtml, htmlToPlainText } from "./body";
import { composeSubject, defaultFromAddress, replyRecipients } from "./reply";
import {
  type ComposeMode,
  type DraftContent,
  type Editor,
  fitsSendLimit,
  MAX_ATTACHMENTS,
  type OutgoingAttachment,
  type OutgoingDetail,
  type OutgoingId,
  type OutgoingSummary,
  type SaveResult,
  TOO_LARGE_TEXT,
} from "./types";
import {
  cleanSubject,
  refusalToSend,
  type SendRefusal,
  withoutRepeatedRecipients,
} from "./validate";
import type { Address } from "../types";

export type StartedDraft = {
  draft: OutgoingDetail;
  // Something a person should know about what came along.
  notice: string | null;
};

export type AttachmentBody = {
  declaredBytes: number | null;
  read: (limit: number) => Promise<ArrayBuffer | null>;
};

export type MailboxOutgoing = {
  list(viewerId: string): Promise<OutgoingSummary[]>;
  detail(id: OutgoingId, viewerId: string): Promise<OutgoingDetail | null>;
  quoteHtml(id: OutgoingId): Promise<string | null>;
  suggest(query: string): Promise<Address[]>;
  start(input: {
    id: OutgoingId;
    mode: Exclude<ComposeMode, "new">;
    parent: MessageDetail;
    body: MessageBody;
    inlineAttachments: {
      info: AttachmentInfo;
      read: () => Promise<ArrayBuffer | null>;
    }[];
    ownAddresses: readonly string[];
    ownDomain: string;
    editor: Editor;
  }): Promise<StartedDraft>;
  save(input: {
    id: OutgoingId;
    baseRevision: number;
    content: DraftContent;
    editor: Editor;
    ownDomain: string;
  }): Promise<SaveResult>;
  send(input: {
    id: OutgoingId;
    content: DraftContent;
    editor: Editor;
    ownDomain: string;
    fromName: string;
  }): Promise<ScheduleResult | { status: "refused"; refusal: SendRefusal }>;
  undo(id: OutgoingId): Promise<boolean>;
  reopen(id: OutgoingId): Promise<boolean>;
  discard(id: OutgoingId): Promise<boolean>;
  upload(input: {
    id: OutgoingId;
    fileName: string;
    mimeType: string;
    body: AttachmentBody;
    fromAddress: string;
    editor: Editor;
  }): Promise<
    | { status: "added"; attachment: OutgoingAttachment }
    | { status: "refused"; httpStatus: number; message: string }
  >;
  removeAttachment(id: OutgoingId, attachmentId: number): Promise<boolean>;
};

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

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

    // Safe to repeat: the id comes from the browser, and each file has a fixed key.
    async start({
      id,
      mode,
      parent,
      body,
      inlineAttachments,
      ownAddresses,
      ownDomain,
      editor,
    }) {
      const existing = await detailOf(id, editor.id);
      if (existing) return { draft: existing, notice: null };

      const prefix = prefixOf(id);
      const quote = await buildQuote(parent, body, mode, ownDomain);
      await Promise.all([
        bucket.put(quoteHtmlKey(prefix), new TextEncoder().encode(quote.html)),
        bucket.put(quoteTextKey(prefix), new TextEncoder().encode(quote.text)),
      ]);

      const carried = mode === "forward" ? inlineAttachments : [];
      const taken = carried.slice(0, MAX_ATTACHMENTS);
      const attachments: NewOutgoing["attachments"] = [];
      for (const [index, attachment] of taken.entries()) {
        const bytes = await attachment.read();
        if (!bytes) continue;
        const r2Key = forwardedAttachmentKey(prefix, index);
        await bucket.put(r2Key, bytes);
        attachments.push({
          filename: cleanFileName(attachment.info.filename) ?? "Attachment",
          mimeType: attachment.info.mimeType,
          size: bytes.byteLength,
          r2Key,
        });
      }

      const recipients = replyRecipients(parent, mode, ownAddresses);
      const input: NewOutgoing = {
        id,
        mode,
        parent: {
          messageId: parent.id as MessageId,
          rfcMessageId: parent.rfcMessageId,
          references: parent.references,
        },
        content: {
          from: defaultFromAddress(parent, ownAddresses),
          to: recipients.to,
          cc: recipients.cc,
          bcc: [],
          subject: composeSubject(parent.subject, mode),
          html: "",
          includeQuote: true,
        },
        r2Prefix: prefix,
        quote: { bytes: byteLength(quote.html), designed: quote.designed },
        attachments,
        editor,
      };
      await stub.createOutgoing(input);
      return {
        draft: (await detailOf(id, editor.id))!,
        notice:
          carried.length > taken.length
            ? `Only the first ${MAX_ATTACHMENTS} files came along, because a message can't have more.`
            : null,
      };
    },

    async save({ id, baseRevision, content, editor, ownDomain }) {
      const clean = await cleanContent(content, ownDomain);
      return (await stub.saveOutgoing({
        id,
        baseRevision,
        ...clean,
        editor,
        r2Prefix: prefixOf(id),
      })) as SaveResult;
    },

    async send({ id, content, editor, ownDomain, fromName }) {
      const cleaned = await cleanContent(content, ownDomain);
      const clean = {
        ...cleaned,
        content: withoutRepeatedRecipients(cleaned.content),
      };
      const current = await detailOf(id, editor.id);
      const refusal = refusalToSend({
        content: clean.content,
        plainText: clean.plainText,
        bodyBytes: byteLength(clean.content.html),
        quoteBytes:
          clean.content.includeQuote && current?.quote
            ? current.quote.bytes
            : 0,
        attachmentSizes: current?.attachments.map((file) => file.size) ?? [],
      });
      if (refusal && current?.state !== "scheduled") {
        return { status: "refused", refusal };
      }
      return (await stub.scheduleOutgoing({
        id,
        ...clean,
        editor,
        r2Prefix: prefixOf(id),
        fromName,
        mailboxId,
      })) as ScheduleResult;
    },

    undo: (id) => stub.undoOutgoing(id),
    reopen: (id) => stub.reopenOutgoing(id),
    discard: (id) => stub.discardOutgoing(id),

    async upload({ id, fileName, mimeType, body, fromAddress, editor }) {
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
      const result = (await stub.addOutgoingAttachment({
        id,
        filename: cleanFileName(fileName) ?? "Attachment",
        mimeType: cleanMimeType(mimeType),
        size: bytes.byteLength,
        r2Key,
        editor,
        r2Prefix: prefix,
        fromAddress,
      })) as AddAttachmentResult;
      if (result.status === "refused") await bucket.delete([r2Key]);
      return result;
    },

    removeAttachment: (id, attachmentId) =>
      stub.removeOutgoingAttachment(id, attachmentId),
  };
}
