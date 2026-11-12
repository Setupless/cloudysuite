import {
  type BoardId,
  type BoardKind,
  type BoardRole,
  levelOfRole,
  type UserId,
} from "@cloudysuite/access";
import type { SqlDriver } from "@cloudysuite/object-sql";
import {
  type ChangeResult,
  type ChecklistItem,
  LIMITS,
  type PlainDate,
  REFUSAL_MESSAGES,
  type RefusalReason,
  type Task,
  type TaskChange,
  type TaskId,
  type TaskStatus,
  UNDO_DELETE_MS,
} from "./types";

// Who is asking, from their grant, which can't cross RPC.
export type Actor = {
  userId: UserId;
  boardId: BoardId;
  role: BoardRole;
  kind: BoardKind;
};

// Can view may only tick off a task assigned to them.
const MAY_MAKE: Record<TaskChange["kind"], "edit" | "editOrAssignee"> = {
  create: "edit",
  rename: "edit",
  setStatus: "editOrAssignee",
  setDue: "edit",
  setNotes: "edit",
  assign: "edit",
  addItem: "edit",
  renameItem: "edit",
  toggleItem: "edit",
  removeItem: "edit",
  delete: "edit",
  undoDelete: "edit",
};

type TaskRow = {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  assignee_name: string | null;
  due: string | null;
  notes: string;
  checklist: string;
  created_by_id: string;
  created_by_name: string;
  created_at: number;
  done_at: number | null;
  deleted_at: number | null;
};

const taskOf = (row: TaskRow): Task => ({
  id: row.id as TaskId,
  title: row.title,
  status: row.status as TaskStatus,
  assignee:
    row.assignee_id === null
      ? null
      : { id: row.assignee_id as UserId, name: row.assignee_name ?? "" },
  due: row.due as PlainDate | null,
  notes: row.notes,
  checklist: JSON.parse(row.checklist) as ChecklistItem[],
  createdBy: { id: row.created_by_id as UserId, name: row.created_by_name },
  createdAt: row.created_at,
  doneAt: row.done_at,
});

const refuse = (reason: RefusalReason): ChangeResult => ({
  status: "refused",
  reason,
  message: REFUSAL_MESSAGES[reason],
});

// Counts what a person sees as one character, such as an emoji, once.
const lengthOf = (text: string) => [...text].length;

type Checked = { text: string } | RefusalReason;

function titleOf(raw: string): Checked {
  const text = raw.trim();
  if (text === "") return "titleEmpty";
  return lengthOf(text) > LIMITS.title ? "titleTooLong" : { text };
}

function itemTextOf(raw: string): Checked {
  const text = raw.trim();
  if (text === "") return "itemEmpty";
  return lengthOf(text) > LIMITS.checklistItem ? "itemTooLong" : { text };
}

function mayMake(actor: Actor, change: TaskChange, row: TaskRow | undefined) {
  const level = levelOfRole(actor.role);
  if (level === "edit") return true;
  return (
    level === "view" &&
    MAY_MAKE[change.kind] === "editOrAssignee" &&
    row?.deleted_at === null &&
    row.assignee_id === actor.userId
  );
}

// The assignee is trusted from the caller: whether they're on the board is in D1, so the
// server function checks it before it asks.
const namesSomeone = (change: TaskChange) =>
  change.kind === "assign" ||
  (change.kind === "create" && change.assignee !== null);

// What a change makes of a task that's there and not deleted.
function changed(
  task: Task,
  change: Exclude<TaskChange, { kind: "create" | "delete" | "undoDelete" }>,
  now: number,
): Task | RefusalReason {
  const itemAt = (itemId: string) =>
    task.checklist.findIndex((item) => item.id === itemId);
  const withItem = (index: number, item: ChecklistItem): Task => ({
    ...task,
    checklist: task.checklist.with(index, item),
  });
  switch (change.kind) {
    case "rename": {
      const title = titleOf(change.title);
      return typeof title === "string" ? title : { ...task, title: title.text };
    }
    case "setStatus":
      return {
        ...task,
        status: change.status,
        doneAt:
          change.status !== "done"
            ? null
            : task.status === "done"
              ? task.doneAt
              : now,
      };
    case "setDue":
      return { ...task, due: change.due };
    case "setNotes":
      return lengthOf(change.notes) > LIMITS.notes
        ? "notesTooLong"
        : { ...task, notes: change.notes };
    case "assign":
      return { ...task, assignee: change.assignee };
    case "addItem": {
      if (itemAt(change.itemId) !== -1) return task;
      if (task.checklist.length >= LIMITS.checklistItems)
        return "checklistFull";
      const text = itemTextOf(change.text);
      if (typeof text === "string") return text;
      return {
        ...task,
        checklist: [
          ...task.checklist,
          { id: change.itemId, text: text.text, done: false },
        ],
      };
    }
    case "renameItem": {
      const index = itemAt(change.itemId);
      if (index === -1) return "itemGone";
      const text = itemTextOf(change.text);
      if (typeof text === "string") return text;
      return withItem(index, { ...task.checklist[index]!, text: text.text });
    }
    case "toggleItem": {
      const index = itemAt(change.itemId);
      if (index === -1) return "itemGone";
      return withItem(index, { ...task.checklist[index]!, done: change.done });
    }
    case "removeItem":
      return {
        ...task,
        checklist: task.checklist.filter((item) => item.id !== change.itemId),
      };
  }
}

// One board's tasks. Each change is checked against who is asking in the same
// transaction that makes it, and each is safe to send twice.
export class TaskStore {
  readonly #db: SqlDriver;

  constructor(db: SqlDriver) {
    this.#db = db;
  }

  #row(id: TaskId): TaskRow | undefined {
    return this.#db
      .exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", id)
      .toArray()[0];
  }

  // Anyone on the board sees every task on it.
  list(_actor: Actor): Task[] {
    return this.#db
      .exec<TaskRow>(
        "SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at, id",
      )
      .toArray()
      .map(taskOf);
  }

  find(_actor: Actor, id: TaskId): Task | null {
    const row = this.#row(id);
    return row && row.deleted_at === null ? taskOf(row) : null;
  }

  change(actor: Actor, change: TaskChange, now: number): ChangeResult {
    return this.#db.transaction(() => {
      const row = this.#row(change.id);
      if (!mayMake(actor, change, row)) return refuse("noAccess");
      if (actor.kind === "personal" && namesSomeone(change)) {
        return refuse("privateBoard");
      }
      switch (change.kind) {
        case "create":
          return this.#create(actor, change, row, now);
        case "delete":
          return this.#delete(row, now);
        case "undoDelete":
          return this.#undoDelete(row, now);
      }
      if (!row || row.deleted_at !== null) return refuse("gone");
      const next = changed(taskOf(row), change, now);
      if (typeof next === "string") return refuse(next);
      this.#write(next);
      return { status: "done", task: next };
    });
  }

  #create(
    actor: Actor,
    change: Extract<TaskChange, { kind: "create" }>,
    row: TaskRow | undefined,
    now: number,
  ): ChangeResult {
    if (row) {
      return row.deleted_at === null
        ? { status: "done", task: taskOf(row) }
        : refuse("gone");
    }
    const title = titleOf(change.title);
    if (typeof title === "string") return refuse(title);
    const task: Task = {
      id: change.id,
      title: title.text,
      status: "todo",
      assignee: change.assignee,
      due: change.due,
      notes: "",
      checklist: [],
      createdBy: { id: actor.userId, name: change.creatorName },
      createdAt: now,
      doneAt: null,
    };
    this.#db.exec(
      `INSERT INTO tasks (id, title, status, assignee_id, assignee_name, due, notes,
         checklist, created_by_id, created_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.title,
      task.status,
      task.assignee?.id ?? null,
      task.assignee?.name ?? null,
      task.due,
      task.notes,
      JSON.stringify(task.checklist),
      task.createdBy.id,
      task.createdBy.name,
      task.createdAt,
    );
    return { status: "done", task };
  }

  #delete(row: TaskRow | undefined, now: number): ChangeResult {
    if (!row) return refuse("gone");
    const deletedAt = row.deleted_at ?? now;
    if (row.deleted_at === null) {
      this.#db.exec(
        "UPDATE tasks SET deleted_at = ? WHERE id = ?",
        deletedAt,
        row.id,
      );
    }
    return { status: "deleted", undoUntil: deletedAt + UNDO_DELETE_MS };
  }

  #undoDelete(row: TaskRow | undefined, now: number): ChangeResult {
    if (!row) return refuse("tooLateToUndo");
    if (row.deleted_at !== null) {
      if (now >= row.deleted_at + UNDO_DELETE_MS)
        return refuse("tooLateToUndo");
      this.#db.exec("UPDATE tasks SET deleted_at = NULL WHERE id = ?", row.id);
    }
    return { status: "done", task: taskOf({ ...row, deleted_at: null }) };
  }

  #write(task: Task): void {
    this.#db.exec(
      `UPDATE tasks SET title = ?, status = ?, assignee_id = ?, assignee_name = ?,
         due = ?, notes = ?, checklist = ?, done_at = ?
       WHERE id = ?`,
      task.title,
      task.status,
      task.assignee?.id ?? null,
      task.assignee?.name ?? null,
      task.due,
      task.notes,
      JSON.stringify(task.checklist),
      task.doneAt,
      task.id,
    );
  }

  // Removes for good every task whose Undo has passed. Running it again changes nothing.
  purgeDeleted(now: number): void {
    this.#db.exec(
      "DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at <= ?",
      now - UNDO_DELETE_MS,
    );
  }

  nextWakeUpAt(): number | null {
    const [row] = this.#db
      .exec<{ at: number | null }>(
        "SELECT MIN(deleted_at) AS at FROM tasks WHERE deleted_at IS NOT NULL",
      )
      .toArray();
    return row?.at == null ? null : row.at + UNDO_DELETE_MS;
  }
}
