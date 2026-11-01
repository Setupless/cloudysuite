import type { MailboxGrant } from "@cloudysuite/access";
import { createMailboxImports, type MailboxImports } from "./import/uploads";
import { rawKey } from "./r2-keys";
import type { SearchInput, SearchPage } from "./search/store";
import { mailboxStub } from "./stub";
import type {
  AttachmentId,
  AttachmentInfo,
  AttachmentRef,
  Folder,
  MailboxSummary,
  MessageBody,
  MessageFlags,
  MessageId,
  MessageRef,
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
  LabelSummary,
  MailboxSummary,
  MessageBody,
  MessageDetail,
  MessageFlags,
  MessageId,
  MessageRef,
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
  summary(): Promise<MailboxSummary>;
  listThreads(query: ThreadQuery): Promise<ThreadPage>;
  search(input: SearchInput): Promise<SearchPage>;
  getThread(threadId: ThreadId): Promise<ThreadDetail | null>;
  threadOfMessage(messageId: MessageId): Promise<ThreadId | null>;
  setFlags(selection: MessageSelection, flags: MessageFlags): Promise<number>;
  moveToFolder(
    selection: MessageSelection,
    folder: Folder,
  ): Promise<MessageRef[]>;
  moveToTrash(selection: MessageSelection): Promise<MessageRef[]>;
  restore(selection: MessageSelection): Promise<MessageRef[]>;
  deleteForever(selection: MessageSelection): Promise<number>;
  getBody(messageId: MessageId): Promise<MessageBody | null>;
  inlineAttachments(messageId: MessageId): Promise<AttachmentInfo[]>;
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
  const moveToFolder = async (selection: MessageSelection, folder: Folder) =>
    (await stub.moveToFolder(selection, folder)) as MessageRef[];

  return {
    summary: async () => (await stub.summary()) as MailboxSummary,
    listThreads: async (query) => (await stub.listThreads(query)) as ThreadPage,
    search: async (input) => (await stub.search(input)) as SearchPage,
    getThread: async (threadId) =>
      (await stub.getThread(threadId)) as ThreadDetail | null,
    threadOfMessage: async (messageId) =>
      (await stub.threadOfMessage(messageId)) as ThreadId | null,
    setFlags: (selection, flags) => stub.setFlags(selection, flags),
    moveToFolder,
    moveToTrash: (selection) => moveToFolder(selection, "trash"),
    restore: async (selection) =>
      (await stub.restore(selection)) as MessageRef[],
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

    async inlineAttachments(messageId) {
      const refs = (await stub.inlineAttachmentRefs(
        messageId,
      )) as AttachmentRef[];
      return refs.map(({ r2Key: _, ...info }) => info);
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

// Importing is the one mailbox action a member may not take. Null is a refusal, so
// no caller can reach an import without facing it.
export function openMailboxImports(
  env: Env,
  grant: MailboxGrant,
): MailboxImports | null {
  if (grant.role !== "manager") return null;
  return createMailboxImports(
    env.BUCKET,
    mailboxStub(env, grant.mailboxId),
    grant.mailboxId,
  );
}
