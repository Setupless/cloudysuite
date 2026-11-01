import type { MailboxGrant } from "@cloudysuite/access";
import { rawKey } from "./r2-keys";
import { mailboxStub } from "./stub";
import type {
  AttachmentId,
  AttachmentInfo,
  Folder,
  MessageBody,
  MessageFlags,
  MessageId,
  MessageSelection,
  ThreadDetail,
  ThreadId,
  ThreadPage,
  ThreadQuery,
} from "./types";

export type {
  Address,
  AttachmentId,
  AttachmentInfo,
  AuthResults,
  Folder,
  LabelId,
  MessageBody,
  MessageDetail,
  MessageFlags,
  MessageId,
  MessageSelection,
  ThreadDetail,
  ThreadId,
  ThreadPage,
  ThreadQuery,
  ThreadSummary,
  ThreadView,
} from "./types";
export { FOLDERS } from "./types";

export type AttachmentDownload = {
  info: AttachmentInfo;
  body: ReadableStream;
};

export type MailboxClient = {
  listThreads(query: ThreadQuery): Promise<ThreadPage>;
  getThread(threadId: ThreadId): Promise<ThreadDetail | null>;
  setFlags(selection: MessageSelection, flags: MessageFlags): Promise<number>;
  moveToFolder(selection: MessageSelection, folder: Folder): Promise<number>;
  moveToTrash(selection: MessageSelection): Promise<number>;
  deleteForever(selection: MessageSelection): Promise<number>;
  getBody(messageId: MessageId): Promise<MessageBody | null>;
  getAttachment(
    messageId: MessageId,
    attachmentId: AttachmentId,
  ): Promise<AttachmentDownload | null>;
  getRaw(messageId: MessageId): Promise<ReadableStream | null>;
};

// The only way for user-facing code to reach a mailbox. A grant cannot cross RPC,
// so the check happens here, on the caller's side, and the Durable Object trusts
// its caller. R2 reads also happen here, so large files do not pass through the
// Durable Object and hold up everyone else using the mailbox.
export function openMailbox(env: Env, grant: MailboxGrant): MailboxClient {
  const stub = mailboxStub(env, grant.mailboxId);
  const moveToFolder = (selection: MessageSelection, folder: Folder) =>
    stub.moveToFolder(selection, folder);

  return {
    listThreads: async (query) => (await stub.listThreads(query)) as ThreadPage,
    getThread: async (threadId) =>
      (await stub.getThread(threadId)) as ThreadDetail | null,
    setFlags: (selection, flags) => stub.setFlags(selection, flags),
    moveToFolder,
    moveToTrash: (selection) => moveToFolder(selection, "trash"),
    deleteForever: (selection) => stub.deleteForever(selection),

    async getBody(messageId) {
      if ((await stub.storagePrefix(messageId)) === null) return null;
      const body: MessageBody = { text: null, html: null };
      for (const part of await stub.bodyRefs(messageId)) {
        body[part.kind] =
          "inline" in part
            ? part.inline
            : ((await (await env.BUCKET.get(part.r2Key))?.text()) ?? null);
      }
      return body;
    },

    async getAttachment(messageId, attachmentId) {
      const ref = await stub.attachmentRef(messageId, attachmentId);
      if (!ref) return null;
      const object = await env.BUCKET.get(ref.r2Key);
      if (!object) return null;
      const { r2Key: _, ...info } = ref;
      return { info: info as AttachmentInfo, body: object.body };
    },

    async getRaw(messageId) {
      const prefix = await stub.storagePrefix(messageId);
      if (prefix === null) return null;
      return (await env.BUCKET.get(rawKey(prefix)))?.body ?? null;
    },
  };
}
