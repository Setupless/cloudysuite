import { type BoardId, parseBoardId, type UserId } from "@cloudysuite/access";
import {
  BOARD_NAME_EMPTY_MESSAGE,
  BOARD_NAME_TOO_LONG_MESSAGE,
  type ChecklistItemId,
  LIMITS,
  MAX_BOARD_NAME_LENGTH,
  type NewPrivateTask,
  type PlainDate,
  parsePlainDate,
  REFUSAL_MESSAGES,
  type RefusalReason,
  TASK_STATUSES,
  type TaskChangeInput,
  type TaskId,
  type TaskStatus,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_USER_ID_LENGTH = 128;

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

function uuid<Id extends string>(raw: unknown): Id {
  if (typeof raw !== "string" || !UUID.test(raw)) throw badRequest();
  return raw as Id;
}

function requireBoardId(raw: unknown): BoardId {
  const id = typeof raw === "string" ? parseBoardId(raw) : null;
  if (!id) throw badRequest();
  return id;
}

function requireUserIdOrNull(raw: unknown): UserId | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_USER_ID_LENGTH)
    throw badRequest();
  return raw as UserId;
}

function requireDueOrNull(raw: unknown): PlainDate | null {
  if (raw === null) return null;
  const date = typeof raw === "string" ? parsePlainDate(raw) : null;
  if (!date) throw badRequest();
  return date;
}

function requireStatus(raw: unknown): TaskStatus {
  if (!TASK_STATUSES.includes(raw as TaskStatus)) throw badRequest();
  return raw as TaskStatus;
}

// The store counts characters and says what's wrong. This only stops a string far too
// long to be worth reading, with the same words.
function text(raw: unknown, limit: number, tooLong: RefusalReason): string {
  if (typeof raw !== "string") throw badRequest();
  if (raw.length > limit * 4) throw refusal(400, REFUSAL_MESSAGES[tooLong]);
  return raw;
}

const title = (raw: unknown) => text(raw, LIMITS.title, "titleTooLong");
const itemText = (raw: unknown) =>
  text(raw, LIMITS.checklistItem, "itemTooLong");

function parseChange(raw: unknown): TaskChangeInput {
  const input = record(raw);
  const id = uuid<TaskId>(input.id);
  const itemId = () => uuid<ChecklistItemId>(input.itemId);
  switch (input.kind) {
    case "create":
      return {
        kind: "create",
        id,
        title: title(input.title),
        due: requireDueOrNull(input.due),
        assigneeId: requireUserIdOrNull(input.assigneeId),
      };
    case "rename":
      return { kind: "rename", id, title: title(input.title) };
    case "setStatus":
      return { kind: "setStatus", id, status: requireStatus(input.status) };
    case "setDue":
      return { kind: "setDue", id, due: requireDueOrNull(input.due) };
    case "setNotes":
      return {
        kind: "setNotes",
        id,
        notes: text(input.notes, LIMITS.notes, "notesTooLong"),
      };
    case "assign":
      return {
        kind: "assign",
        id,
        assigneeId: requireUserIdOrNull(input.assigneeId),
      };
    case "addItem":
      return {
        kind: "addItem",
        id,
        itemId: itemId(),
        text: itemText(input.text),
      };
    case "renameItem":
      return {
        kind: "renameItem",
        id,
        itemId: itemId(),
        text: itemText(input.text),
      };
    case "toggleItem":
      if (typeof input.done !== "boolean") throw badRequest();
      return { kind: "toggleItem", id, itemId: itemId(), done: input.done };
    case "removeItem":
      return { kind: "removeItem", id, itemId: itemId() };
    case "delete":
      return { kind: "delete", id };
    case "undoDelete":
      return { kind: "undoDelete", id };
    default:
      throw badRequest();
  }
}

export const parseBoardInput = (raw: unknown) => ({
  boardId: requireBoardId(record(raw).boardId),
});

export const parseChangeInput = (raw: unknown) => {
  const input = record(raw);
  return {
    boardId: requireBoardId(input.boardId),
    change: parseChange(input.change),
  };
};

export const parseNewPrivateTaskInput = (raw: unknown): NewPrivateTask => {
  const input = record(raw);
  return {
    id: uuid<TaskId>(input.id),
    title: title(input.title),
    due: requireDueOrNull(input.due),
  };
};

export const parseNewBoardInput = (raw: unknown) => {
  const name = record(raw).name;
  if (typeof name !== "string") throw badRequest();
  const trimmed = name.trim();
  if (trimmed === "") throw refusal(400, BOARD_NAME_EMPTY_MESSAGE);
  if (
    name.length > MAX_BOARD_NAME_LENGTH * 4 ||
    [...trimmed].length > MAX_BOARD_NAME_LENGTH
  ) {
    throw refusal(400, BOARD_NAME_TOO_LONG_MESSAGE);
  }
  return { name: trimmed };
};
