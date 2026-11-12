import type { UserId } from "@cloudysuite/access";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type TaskId = Brand<string, "TaskId">;
export type ChecklistItemId = Brand<string, "ChecklistItemId">;

export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

// A due day, the same in every time zone, like an all-day event.
export type PlainDate = Brand<string, "PlainDate">;

export type Person = { id: UserId; name: string };

export type ChecklistItem = {
  id: ChecklistItemId;
  text: string;
  done: boolean;
};

export type Task = {
  id: TaskId;
  title: string;
  status: TaskStatus;
  assignee: Person | null;
  due: PlainDate | null;
  notes: string;
  checklist: ChecklistItem[];
  createdBy: Person;
  createdAt: number;
  doneAt: number | null;
};

// Counted in characters as a person sees them, after trimming a title or an item.
export const LIMITS = {
  title: 200,
  notes: 10_000,
  checklistItems: 50,
  checklistItem: 200,
} as const;

export const UNDO_DELETE_MS = 10_000;

// Every id is made by the caller, so a change sent twice finds what the first one made.
export type TaskChange =
  | {
      kind: "create";
      id: TaskId;
      title: string;
      due: PlainDate | null;
      assignee: Person | null;
      creatorName: string;
    }
  | { kind: "rename"; id: TaskId; title: string }
  | { kind: "setStatus"; id: TaskId; status: TaskStatus }
  | { kind: "setDue"; id: TaskId; due: PlainDate | null }
  | { kind: "setNotes"; id: TaskId; notes: string }
  | { kind: "assign"; id: TaskId; assignee: Person | null }
  | { kind: "addItem"; id: TaskId; itemId: ChecklistItemId; text: string }
  | { kind: "renameItem"; id: TaskId; itemId: ChecklistItemId; text: string }
  | { kind: "toggleItem"; id: TaskId; itemId: ChecklistItemId; done: boolean }
  | { kind: "removeItem"; id: TaskId; itemId: ChecklistItemId }
  | { kind: "delete"; id: TaskId }
  | { kind: "undoDelete"; id: TaskId };

export type RefusalReason =
  | "noAccess"
  | "gone"
  | "privateBoard"
  | "titleEmpty"
  | "titleTooLong"
  | "notesTooLong"
  | "checklistFull"
  | "itemEmpty"
  | "itemTooLong"
  | "itemGone"
  | "tooLateToUndo";

export const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  noAccess:
    "You can view this board but not change it. Ask one of its managers for Can edit.",
  gone: "That task has been deleted.",
  privateBoard:
    "Your private tasks are just for you, so they can't be assigned to anyone.",
  titleEmpty: "Give the task a title.",
  titleTooLong: `A title can be up to ${LIMITS.title} characters. Make it shorter.`,
  notesTooLong: `Notes can be up to ${LIMITS.notes.toLocaleString("en-US")} characters. Make them shorter.`,
  checklistFull: `A checklist can have up to ${LIMITS.checklistItems} items. Remove one to add another.`,
  itemEmpty: "Give the checklist item some text.",
  itemTooLong: `A checklist item can be up to ${LIMITS.checklistItem} characters. Make it shorter.`,
  itemGone: "That checklist item has been removed.",
  tooLateToUndo: "It's too late to undo. The task has been deleted.",
};

export type Refusal = {
  status: "refused";
  reason: RefusalReason;
  message: string;
};

export type ChangeResult =
  | { status: "done"; task: Task }
  // Undo works until `undoUntil`.
  | { status: "deleted"; undoUntil: number }
  | Refusal;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parsePlainDate(raw: string): PlainDate | null {
  const match = DATE.exec(raw);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.toISOString().slice(0, 10) === raw ? (raw as PlainDate) : null;
}
