import type {
  BoardId,
  BoardKind,
  BoardRole,
  UserId,
} from "@cloudysuite/access";

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

// Where a task is going, as its board shows it while it's locked. A private board is
// named after its owner.
export type MoveDestination = { kind: BoardKind; name: string };

export type TaskMoving = MoveDestination & { by: UserId };

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
  // Set while the task is on its way to another board. Nothing can change it meanwhile.
  moving: TaskMoving | null;
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
  | "tooLateToUndo"
  | "moving";

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
  moving: "This task is being moved to another board. Try again in a minute.",
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

// A team board in the sidebar, from D1 alone.
export type BoardEntry = {
  id: BoardId;
  kind: BoardKind;
  name: string;
  colour: number;
  role: BoardRole;
};

export type BoardOfTask = Omit<BoardEntry, "role">;

export type MyTask = Task & { board: BoardOfTask };

// `unreachable` counts the boards that didn't answer in time.
export type MyTasks = { tasks: MyTask[]; unreachable: number };

export type BoardTasks = { role: BoardRole; kind: BoardKind; tasks: Task[] };

// Someone in the organisation, who may or may not be on a board.
export type Colleague = { id: UserId; name: string; email: string };

// A suspended member stays on the list, so a manager can still remove them, but can't
// be given a task.
export type Member = Colleague & {
  role: BoardRole;
  joinedAt: number;
  suspended: boolean;
};

// A team board's settings. Members come in the order they joined.
export type BoardSettings = {
  board: { id: BoardId; name: string; colour: number };
  myRole: BoardRole;
  members: Member[];
};

// What a board's settings can change.
export type SettingsChange =
  | { kind: "add"; userId: UserId; role: BoardRole }
  | { kind: "setRole"; userId: UserId; role: BoardRole }
  | { kind: "remove"; userId: UserId }
  | { kind: "leave" }
  | { kind: "rename"; name: string }
  | { kind: "setColour"; colour: number }
  | { kind: "delete" };

// Only a manager adds members anywhere in the suite. Anyone on a board may leave it,
// unless they're its last manager.
export const MAY_CHANGE_SETTINGS: Record<
  SettingsChange["kind"],
  "manager" | "anyone"
> = {
  add: "manager",
  setRole: "manager",
  remove: "manager",
  leave: "anyone",
  rename: "manager",
  setColour: "manager",
  delete: "manager",
};

export const mayChangeSettings = (
  role: BoardRole,
  kind: SettingsChange["kind"],
): boolean => MAY_CHANGE_SETTINGS[kind] === "anyone" || role === "manager";

// What the assignee picker offers for the text typed: the board's members, then everyone
// else in the organisation.
export type AssigneeChoices = { onBoard: Member[]; others: Colleague[] };

// Adding someone while assigning gives them the team folder default.
export const ADDED_WHILE_ASSIGNING_ROLE: BoardRole = "editor";

// What a page sends. People come as ids, and the server reads their names from D1.
export type TaskChangeInput =
  | Exclude<TaskChange, { kind: "create" | "assign" }>
  | {
      kind: "create";
      id: TaskId;
      title: string;
      due: PlainDate | null;
      assigneeId: UserId | null;
    }
  | { kind: "assign"; id: TaskId; assigneeId: UserId | null };

export type NewPrivateTask = {
  id: TaskId;
  title: string;
  due: PlainDate | null;
};

export type ChangeAnswer = Exclude<ChangeResult, Refusal>;

// The start of today, in any time zone, is at most 25 hours ago, on the day clocks go
// back. So this holds every task done today wherever the person is, and their device
// picks out its own day.
export const DONE_TODAY_LOOKBACK_MS = 25 * 60 * 60 * 1000;

export const MAX_BOARD_NAME_LENGTH = 100;

export const NO_ACCESS_MESSAGE =
  "You aren't on this board, or it has been deleted. Ask one of its managers to add you.";
export const NOT_ON_BOARD_MESSAGE =
  "That person isn't on this board. Ask one of its managers to add them first.";
export const BOARD_NAME_EMPTY_MESSAGE = "Give the board a name.";
export const ONLY_MANAGERS_MESSAGE =
  "Only a manager of this board can do that.";
export const LAST_MANAGER_MESSAGE =
  "A team board needs at least one manager. Make someone else a manager first.";
export const NOT_ON_IT_MESSAGE = "That person isn't on this board.";
export const NOT_A_PERSON_MESSAGE =
  "That person can't be added. They may have been removed or suspended.";
export const PRIVATE_BOARD_MESSAGE =
  "Your private tasks are just for you. Nobody else can be added, and they can't be left or deleted.";
export const BOARD_NAME_TOO_LONG_MESSAGE = `Use a name of ${MAX_BOARD_NAME_LENGTH} characters or fewer.`;

// The other board is told who moves the task, and checks them again itself.
export type MoveOutcome =
  | { status: "moved" }
  // The other board hasn't answered. The alarm keeps asking.
  | { status: "pending" }
  | Refusal
  | { status: "refusedThere"; reason: "noAccess" | "busy" | "dropped" };

// "private" is the person's own board, which the move makes if it's needed.
export type MoveTarget = BoardId | "private";

export type MoveAnswer = {
  status: "moved" | "moving";
  to: BoardOfTask;
};

export const ALREADY_THERE_MESSAGE = "The task is already on this board.";

export const viewOnlyThereMessage = (name: string) =>
  `You can view ${name} but not add tasks to it. Ask one of its managers for Can edit.`;

export const refusedThereMessage = (
  reason: Extract<MoveOutcome, { status: "refusedThere" }>["reason"],
  name: string,
) =>
  reason === "noAccess"
    ? `You can no longer add tasks to ${name}, so the task is still here.`
    : `The task couldn't be moved to ${name} just now, so it is still here. Try again in a minute.`;
