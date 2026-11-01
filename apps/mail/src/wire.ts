import { type MailboxId, parseMailboxId } from "@cloudysuite/access";
import {
  type AttachmentId,
  FOLDERS,
  type Folder,
  type LabelId,
  type MessageFlags,
  type MessageId,
  type MessageSelection,
  type ThreadId,
  type ThreadView,
} from "./types";

// Everything a browser sends to a mailbox function passes through these.
const MAX_SELECTED = 100;
const MAX_CURSOR_LENGTH = 64;
const MAX_PAGE_SIZE = 100;

export function badRequest(): Response {
  return new Response(
    JSON.stringify({ message: "That request isn't valid." }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

const record = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) throw badRequest();
  return raw as Record<string, unknown>;
};

export function requireMailboxId(raw: unknown): MailboxId {
  const id = typeof raw === "string" ? parseMailboxId(raw) : null;
  if (!id) throw badRequest();
  return id;
}

const positiveId = <Id>(raw: unknown): Id => {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw badRequest();
  }
  return raw as Id;
};

export const requireMessageId = (raw: unknown) => positiveId<MessageId>(raw);
export const requireThreadId = (raw: unknown) => positiveId<ThreadId>(raw);
export const requireAttachmentId = (raw: unknown) =>
  positiveId<AttachmentId>(raw);

export function requireFolder(raw: unknown): Folder {
  if (!FOLDERS.includes(raw as Folder)) throw badRequest();
  return raw as Folder;
}

function requireView(raw: unknown): ThreadView {
  const view = record(raw);
  return "folder" in view
    ? { folder: requireFolder(view.folder) }
    : { labelId: positiveId<LabelId>(view.labelId) };
}

function requireIds<Id>(raw: unknown): Id[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SELECTED) {
    throw badRequest();
  }
  return raw.map((id) => positiveId<Id>(id));
}

function requireSelection(raw: unknown): MessageSelection {
  const selection = record(raw);
  if ("messageIds" in selection) {
    return { messageIds: requireIds<MessageId>(selection.messageIds) };
  }
  return {
    threadIds: requireIds<ThreadId>(selection.threadIds),
    inFolder:
      selection.inFolder === undefined
        ? undefined
        : requireFolder(selection.inFolder),
  };
}

function optionalBoolean(raw: unknown): boolean | undefined {
  if (raw !== undefined && typeof raw !== "boolean") throw badRequest();
  return raw;
}

export const parseMailboxInput = (raw: unknown) => ({
  mailboxId: requireMailboxId(record(raw).mailboxId),
});

export const parseListInput = (raw: unknown) => {
  const input = record(raw);
  const { cursor, limit } = input;
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH)
  ) {
    throw badRequest();
  }
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE)
  ) {
    throw badRequest();
  }
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    view: requireView(input.view),
    cursor: cursor as string | undefined,
    limit: limit as number | undefined,
  };
};

export const parseThreadInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    threadId: requireThreadId(input.threadId),
  };
};

export const parseMessageInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    messageId: requireMessageId(input.messageId),
  };
};

export const parseSelectionInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    selection: requireSelection(input.selection),
  };
};

export const parseFlagsInput = (raw: unknown) => {
  const input = record(raw);
  const flagsInput = record(input.flags);
  const flags: MessageFlags = {
    read: optionalBoolean(flagsInput.read),
    starred: optionalBoolean(flagsInput.starred),
  };
  if (flags.read === undefined && flags.starred === undefined) {
    throw badRequest();
  }
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    selection: requireSelection(input.selection),
    flags,
  };
};

export const parseMoveInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    selection: requireSelection(input.selection),
    folder: requireFolder(input.folder),
  };
};
