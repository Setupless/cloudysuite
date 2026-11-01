import { type MailboxId, parseMailboxId } from "@cloudysuite/access";
import { cleanLabelName, MAX_LABEL_NAME_LENGTH } from "./labels/store";
import { MAX_SEARCH_LENGTH } from "./search/query";
import {
  type AttachmentId,
  FOLDERS,
  type Folder,
  LABEL_COLOURS,
  type LabelColour,
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

export function refusal(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const record = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) throw badRequest();
  return raw as Record<string, unknown>;
};

export function requireMailboxId(raw: unknown): MailboxId {
  const id = typeof raw === "string" ? parseMailboxId(raw) : null;
  if (!id) throw badRequest();
  return id;
}

export const positiveId = <Id>(raw: unknown): Id => {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw badRequest();
  }
  return raw as Id;
};

export const requireMessageId = (raw: unknown) => positiveId<MessageId>(raw);
export const requireThreadId = (raw: unknown) => positiveId<ThreadId>(raw);
export const requireAttachmentId = (raw: unknown) =>
  positiveId<AttachmentId>(raw);

export const requireLabelId = (raw: unknown) => positiveId<LabelId>(raw);

function requireLabelName(raw: unknown): string {
  const name = typeof raw === "string" ? cleanLabelName(raw) : null;
  if (name === null) {
    throw refusal(
      400,
      `Give the label a name of up to ${MAX_LABEL_NAME_LENGTH} characters.`,
    );
  }
  return name;
}

function requireColour(raw: unknown): LabelColour {
  if (!LABEL_COLOURS.includes(raw as LabelColour)) throw badRequest();
  return raw as LabelColour;
}

export function requireFolder(raw: unknown): Folder {
  if (!FOLDERS.includes(raw as Folder)) throw badRequest();
  return raw as Folder;
}

function requireFolderScope(raw: unknown): Folder | Folder[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return requireFolder(raw);
  if (raw.length === 0 || raw.length > FOLDERS.length) throw badRequest();
  return raw.map(requireFolder);
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
    inFolder: requireFolderScope(selection.inFolder),
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

// The reader's Date.getTimezoneOffset, in minutes. No place is more than 14 hours
// from UTC.
const MAX_OFFSET_MINUTES = 14 * 60;

// Text past the limit is cut here, so an enormous string never crosses to the
// Durable Object, and the parser still sees that it was too long.
export const parseSearchInput = (raw: unknown) => {
  const input = record(raw);
  const { text, offsetMinutes, cursor } = input;
  if (typeof text !== "string") throw badRequest();
  if (
    typeof offsetMinutes !== "number" ||
    !Number.isSafeInteger(offsetMinutes) ||
    Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES
  ) {
    throw badRequest();
  }
  if (
    cursor !== undefined &&
    (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH)
  ) {
    throw badRequest();
  }
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    text: text.slice(0, MAX_SEARCH_LENGTH + 1),
    offsetMinutes,
    cursor: cursor as string | undefined,
  };
};

export const parseNewLabelInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    name: requireLabelName(input.name),
    colour: requireColour(input.colour),
  };
};

export const parseLabelChangeInput = (raw: unknown) => {
  const input = record(raw);
  if (input.name === undefined && input.colour === undefined) {
    throw badRequest();
  }
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    labelId: requireLabelId(input.labelId),
    name: input.name === undefined ? undefined : requireLabelName(input.name),
    colour:
      input.colour === undefined ? undefined : requireColour(input.colour),
  };
};

export const parseLabelInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    labelId: requireLabelId(input.labelId),
  };
};

export const parseSetLabelInput = (raw: unknown) => {
  const input = record(raw);
  if (typeof input.applied !== "boolean") throw badRequest();
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    selection: requireSelection(input.selection),
    labelId: requireLabelId(input.labelId),
    applied: input.applied,
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
