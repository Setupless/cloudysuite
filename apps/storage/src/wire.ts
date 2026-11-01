import {
  type DriveId,
  parseDriveId,
  parseMailboxId,
} from "@cloudysuite/access";
import type { AttachmentId, MessageId } from "@cloudysuite/mail/client";
import { type ItemId, parseItemId } from "./types";

// Everything a browser sends to a Storage function passes through these.
const MAX_CURSOR_LENGTH = 2048;
const MAX_NAME_INPUT_LENGTH = 4096;
const CURSOR = /^(folder|file):/;

export function refusal(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const badRequest = () => refusal(400, "That request isn't valid.");

const record = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) throw badRequest();
  return raw as Record<string, unknown>;
};

function requireDriveId(raw: unknown): DriveId {
  const id = typeof raw === "string" ? parseDriveId(raw) : null;
  if (!id) throw badRequest();
  return id;
}

function requireItemId(raw: unknown): ItemId {
  const id = typeof raw === "string" ? parseItemId(raw) : null;
  if (!id) throw badRequest();
  return id;
}

const optionalItemId = (raw: unknown): ItemId | null =>
  raw === null || raw === undefined ? null : requireItemId(raw);

function requireName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MAX_NAME_INPUT_LENGTH) {
    throw badRequest();
  }
  return raw;
}

export function parseFolderInput(raw: unknown) {
  const input = record(raw);
  const { cursor } = input;
  if (
    cursor !== undefined &&
    cursor !== null &&
    (typeof cursor !== "string" ||
      cursor.length > MAX_CURSOR_LENGTH ||
      !CURSOR.test(cursor))
  ) {
    throw badRequest();
  }
  return {
    driveId: requireDriveId(input.driveId),
    folderId: optionalItemId(input.folderId),
    cursor: cursor ?? null,
  } as { driveId: DriveId; folderId: ItemId | null; cursor: string | null };
}

export function parseFileInput(raw: unknown) {
  const input = record(raw);
  return {
    driveId: requireDriveId(input.driveId),
    fileId: requireItemId(input.fileId),
  };
}

export function parseNewFolderInput(raw: unknown) {
  const input = record(raw);
  return {
    driveId: requireDriveId(input.driveId),
    parentId: optionalItemId(input.parentId),
    name: requireName(input.name),
  };
}

export const parseNewTeamFolderInput = (raw: unknown) => ({
  name: requireName(record(raw).name),
});

export function parseRecentInput(raw: unknown) {
  const { limit } = record(raw);
  if (limit !== 4 && limit !== 50) throw badRequest();
  return { limit };
}

function requirePositiveId<Id>(raw: unknown): Id {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw badRequest();
  }
  return raw as Id;
}

export function parseMailAttachmentInput(raw: unknown) {
  const input = record(raw);
  const mailboxId =
    typeof input.mailboxId === "string"
      ? parseMailboxId(input.mailboxId)
      : null;
  if (!mailboxId) throw badRequest();
  return {
    mailboxId,
    messageId: requirePositiveId<MessageId>(input.messageId),
    attachmentId: requirePositiveId<AttachmentId>(input.attachmentId),
  };
}
