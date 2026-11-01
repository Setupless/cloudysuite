import { badRequest, requireMailboxId, requireMessageId } from "../wire";
import type { Address } from "../types";
import {
  COMPOSE_MODES,
  type ComposeMode,
  type DraftContent,
  MAX_BODY_BYTES,
  MAX_SUBJECT_LENGTH,
  type OutgoingId,
} from "./types";
import { singleLineText } from "./validate";

const OUTGOING_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

// A draft may hold more people than a message can go to. Sending says so plainly.
const MAX_PEOPLE_IN_FIELD = 500;
const MAX_ADDRESS_INPUT = 320;
const MAX_NAME_INPUT = 320;
const MAX_QUERY_LENGTH = 128;

const record = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) throw badRequest();
  return raw as Record<string, unknown>;
};

export const parseOutgoingId = (raw: unknown): OutgoingId | null =>
  typeof raw === "string" && OUTGOING_ID.test(raw) ? (raw as OutgoingId) : null;

function requireOutgoingId(raw: unknown): OutgoingId {
  const id = parseOutgoingId(raw);
  if (!id) throw badRequest();
  return id;
}

function requirePeople(raw: unknown): Address[] {
  if (!Array.isArray(raw) || raw.length > MAX_PEOPLE_IN_FIELD)
    throw badRequest();
  return raw.map((entry) => {
    const { name, address } = record(entry);
    if (
      typeof name !== "string" ||
      typeof address !== "string" ||
      name.length > MAX_NAME_INPUT ||
      address.length > MAX_ADDRESS_INPUT
    ) {
      throw badRequest();
    }
    // An address keeps its exact text until it is checked at sending, where a line
    // break in it gets refused by name. A name can only ever become a header's text.
    return { name: singleLineText(name), address: address.trim() };
  });
}

function requireContent(raw: unknown): DraftContent {
  const input = record(raw);
  const { from, subject, html, includeQuote } = input;
  if (
    typeof from !== "string" ||
    from.length > MAX_ADDRESS_INPUT ||
    typeof subject !== "string" ||
    subject.length > MAX_SUBJECT_LENGTH * 4 ||
    typeof html !== "string" ||
    // Twice the limit, so cleaning can bring pasted markup under it before it counts.
    html.length > MAX_BODY_BYTES * 2 ||
    typeof includeQuote !== "boolean"
  ) {
    throw badRequest();
  }
  return {
    from: from.trim().toLowerCase(),
    to: requirePeople(input.to),
    cc: requirePeople(input.cc),
    bcc: requirePeople(input.bcc),
    subject,
    html,
    includeQuote,
  };
}

const requireRevision = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw badRequest();
  }
  return raw;
};

export const parseOutgoingInput = (raw: unknown) => {
  const input = record(raw);
  return {
    mailboxId: requireMailboxId(input.mailboxId),
    id: requireOutgoingId(input.id),
  };
};

export const parseDiscardInput = (raw: unknown) => {
  const { onlyAtRevision } = record(raw);
  return {
    ...parseOutgoingInput(raw),
    ...(onlyAtRevision === undefined
      ? {}
      : { onlyAtRevision: requireRevision(onlyAtRevision) }),
  };
};

export const parseStartInput = (raw: unknown) => {
  const input = record(raw);
  const mode = input.mode as ComposeMode;
  if (!COMPOSE_MODES.includes(mode) || mode === "new") throw badRequest();
  return {
    ...parseOutgoingInput(raw),
    mode,
    parentMessageId: requireMessageId(input.parentMessageId),
  };
};

export const parseSaveInput = (raw: unknown) => {
  const input = record(raw);
  return {
    ...parseOutgoingInput(raw),
    baseRevision: requireRevision(input.baseRevision),
    content: requireContent(input.content),
  };
};

export const parseSaveKeptInput = (raw: unknown) => {
  const save = parseSaveInput(raw);
  const copyId = requireOutgoingId(record(raw).copyId);
  if (copyId === save.id) throw badRequest();
  return { ...save, copyId };
};

export const parseRemoveAttachmentInput = (raw: unknown) => {
  const input = record(raw);
  const { attachmentId } = input;
  if (
    typeof attachmentId !== "number" ||
    !Number.isSafeInteger(attachmentId) ||
    attachmentId < 1
  ) {
    throw badRequest();
  }
  return { ...parseOutgoingInput(raw), attachmentId };
};

export const parseSuggestInput = (raw: unknown) => {
  const input = record(raw);
  const { query } = input;
  if (typeof query !== "string" || query.length > MAX_QUERY_LENGTH) {
    throw badRequest();
  }
  return { mailboxId: requireMailboxId(input.mailboxId), query: query.trim() };
};
