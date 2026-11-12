import {
  type BoardId,
  type BoardKind,
  type BoardRole,
  levelOfRole,
  type UserId,
} from "@cloudysuite/access";
import type { SqlDriver } from "@cloudysuite/object-sql";
import {
  INCOMING_STEPS,
  type IncomingEvent,
  type IncomingPhase,
  type MoveDelivery,
  OUTGOING_STEPS,
  type OutgoingEvent,
  type OutgoingMove,
  type OutgoingPhase,
  type ReceiveAnswer,
} from "./moves";
import {
  type ChangeResult,
  type ChecklistItem,
  LIMITS,
  type MoveDestination,
  type MoveOutcome,
  type PlainDate,
  REFUSAL_MESSAGES,
  type Refusal,
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
  moving_kind: string | null;
  moving_name: string | null;
  moving_by: string | null;
};

// A task is locked while a locked move out names it.
const TASKS = `SELECT tasks.*, moves_out.to_kind AS moving_kind,
    moves_out.to_name AS moving_name, moves_out.moved_by AS moving_by
  FROM tasks LEFT JOIN moves_out
    ON moves_out.task_id = tasks.id AND moves_out.phase = 'locked'`;

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
  moving:
    row.moving_by === null
      ? null
      : {
          kind: row.moving_kind as MoveDestination["kind"],
          name: row.moving_name ?? "",
          by: row.moving_by as UserId,
        },
});

const refuse = (reason: RefusalReason): Extract<ChangeResult, Refusal> => ({
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

  #rows<Row extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): Row[] {
    return this.#db.exec<Row>(query, ...bindings).toArray();
  }

  #row(id: TaskId): TaskRow | undefined {
    return this.#rows<TaskRow>(`${TASKS} WHERE tasks.id = ?`, id)[0];
  }

  // A task moving away, or a copy still arriving under this id, can't change.
  #isHeld(id: TaskId, row: TaskRow | undefined): boolean {
    return (
      row?.moving_by != null ||
      this.#rows(
        "SELECT 1 AS found FROM moves_in WHERE task_id = ? AND phase = 'locked'",
        id,
      ).length > 0
    );
  }

  // Anyone on the board sees every task on it.
  list(_actor: Actor): Task[] {
    return this.#db
      .exec<TaskRow>(
        `${TASKS} WHERE deleted_at IS NULL ORDER BY created_at, tasks.id`,
      )
      .toArray()
      .map(taskOf);
  }

  // For My tasks: what's open or done since `doneSince`, of a team board only what's
  // assigned to the person asking.
  listMine(actor: Actor, doneSince: number): Task[] {
    return this.#db
      .exec<TaskRow>(
        `${TASKS}
         WHERE deleted_at IS NULL
           AND (status != 'done' OR done_at >= ?)
           AND (? = 'personal' OR assignee_id = ?)
         ORDER BY created_at, tasks.id`,
        doneSince,
        actor.kind,
        actor.userId,
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
      if (this.#isHeld(change.id, row)) return refuse("moving");
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
      moving: null,
    };
    this.#insert(task);
    return { status: "done", task };
  }

  #insert(task: Task): void {
    this.#db.exec(
      `INSERT INTO tasks (id, title, status, assignee_id, assignee_name, due, notes,
         checklist, created_by_id, created_by_name, created_at, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      task.doneAt,
    );
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

  // What the delete confirmation names. A task waiting out its Undo is already gone.
  count(_actor: Actor): number {
    const [row] = this.#db
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM tasks WHERE deleted_at IS NULL",
      )
      .toArray();
    return row?.total ?? 0;
  }

  // Empties a deleted board. Running it again changes nothing. A task already on its way
  // out carries on to the other board, and a copy still arriving goes with this one.
  erase(actor: Actor): "done" | "noAccess" {
    if (actor.role !== "manager") return "noAccess";
    this.#db.transaction(() => {
      this.#db.exec("DELETE FROM tasks");
      const arriving = this.#rows<{ id: string }>(
        "SELECT id FROM moves_in WHERE phase = 'locked'",
      );
      for (const { id } of arriving) this.#stepIn(id, { event: "drop" });
    });
    return "done";
  }

  // The task is locked by the row this writes, in the same transaction as the checks.
  beginMoveOut(
    actor: Actor,
    input: {
      moveId: string;
      id: TaskId;
      toBoardId: BoardId;
      to: MoveDestination;
      // The assignee arrives only if the server function found them on the other board.
      keepAssigneeId: UserId | null;
      tryAt: number;
      giveUpAt: number;
    },
  ):
    | Exclude<MoveOutcome, { status: "moved" | "pending" }>
    | { status: "begun" } {
    return this.#db.transaction(() => {
      if (levelOfRole(actor.role) !== "edit") return refuse("noAccess");
      const row = this.#row(input.id);
      if (!row || row.deleted_at !== null) return refuse("gone");
      if (this.#isHeld(input.id, row)) return refuse("moving");
      const task = taskOf(row);
      const arriving: Task = {
        ...task,
        assignee:
          task.assignee?.id === input.keepAssigneeId ? task.assignee : null,
      };
      this.#db.exec(
        `INSERT INTO moves_out (id, task_id, to_board_id, to_kind, to_name, moved_by,
           phase, task, try_at, give_up_at)
         VALUES (?, ?, ?, ?, ?, ?, 'locked', ?, ?, ?)`,
        input.moveId,
        input.id,
        input.toBoardId,
        input.to.kind,
        input.to.name,
        actor.userId,
        JSON.stringify(arriving),
        input.tryAt,
        input.giveUpAt,
      );
      return { status: "begun" as const };
    });
  }

  outgoingMove(moveId: string): OutgoingMove | null {
    const [row] = this.#rows<{
      phase: string;
      to_board_id: string;
      moved_by: string;
      task: string;
      give_up_at: number;
    }>(
      "SELECT phase, to_board_id, moved_by, task, give_up_at FROM moves_out WHERE id = ?",
      moveId,
    );
    return row
      ? {
          moveId,
          phase: row.phase as OutgoingPhase,
          toBoardId: row.to_board_id as BoardId,
          movedBy: row.moved_by as UserId,
          task: JSON.parse(row.task) as Task,
          giveUpAt: row.give_up_at,
        }
      : null;
  }

  // Every change to a move out goes through here, and a step its phase doesn't allow
  // changes nothing, so a late or repeated answer can't undo a later one.
  advanceOut(moveId: string, event: OutgoingEvent, tryAt: number): void {
    this.#db.transaction(() => {
      const [move] = this.#rows<{ phase: string; task_id: string }>(
        "SELECT phase, task_id FROM moves_out WHERE id = ?",
        moveId,
      );
      const next = move && OUTGOING_STEPS[move.phase as OutgoingPhase][event];
      if (!move || !next) return;
      // The other board holds a locked copy now, so this one can go.
      if (event === "added") {
        this.#db.exec("DELETE FROM tasks WHERE id = ?", move.task_id);
      }
      if (next === "ended") {
        this.#db.exec("DELETE FROM moves_out WHERE id = ?", moveId);
      } else {
        this.#db.exec(
          "UPDATE moves_out SET phase = ?, try_at = ? WHERE id = ?",
          next,
          tryAt,
          moveId,
        );
      }
    });
  }

  dueMoves(now: number, limit: number): string[] {
    return this.#rows<{ id: string }>(
      "SELECT id FROM moves_out WHERE try_at <= ? ORDER BY try_at LIMIT ?",
      now,
      limit,
    ).map((row) => row.id);
  }

  postponeMove(moveId: string, tryAt: number): void {
    this.#db.exec(
      "UPDATE moves_out SET try_at = ? WHERE id = ?",
      tryAt,
      moveId,
    );
  }

  #incomingPhase(moveId: string): IncomingPhase | "unheard" {
    const [row] = this.#rows<{ phase: string }>(
      "SELECT phase FROM moves_in WHERE id = ?",
      moveId,
    );
    return (row?.phase as IncomingPhase | undefined) ?? "unheard";
  }

  // Every change to a move in goes through here, and a step its phase doesn't allow
  // changes nothing.
  #stepIn(
    moveId: string,
    step:
      { event: "add"; task: Task } | { event: Exclude<IncomingEvent, "add"> },
  ): void {
    const next = INCOMING_STEPS[this.#incomingPhase(moveId)][step.event];
    if (!next) return;
    if (step.event === "add") {
      this.#db.exec(
        "INSERT INTO moves_in (id, task_id, phase, task) VALUES (?, ?, 'locked', ?)",
        moveId,
        step.task.id,
        JSON.stringify(step.task),
      );
      return;
    }
    if (next === "unlocked") {
      const [held] = this.#rows<{ task: string }>(
        "SELECT task FROM moves_in WHERE id = ?",
        moveId,
      );
      if (held) this.#insert(JSON.parse(held.task) as Task);
    }
    this.#db.exec(
      `INSERT INTO moves_in (id, phase) VALUES (?, ?)
       ON CONFLICT (id) DO UPDATE SET phase = excluded.phase, task = NULL`,
      moveId,
      next,
    );
  }

  // `actor` is the mover's grant on this board, checked again for every delivery.
  receiveMove(actor: Actor, delivery: MoveDelivery): ReceiveAnswer {
    return this.#db.transaction((): ReceiveAnswer => {
      const phase = this.#incomingPhase(delivery.moveId);
      if (phase === "dropped") return { status: "refused", reason: "dropped" };
      if (phase !== "unheard") return { status: "added" };
      if (levelOfRole(actor.role) !== "edit") {
        return { status: "refused", reason: "noAccess" };
      }
      const id = delivery.task.id;
      // Only a task made with a borrowed id, or one whose last move here is still being
      // dropped, can already be here.
      if (this.#row(id) || this.#isHeld(id, undefined)) {
        return { status: "refused", reason: "busy" };
      }
      this.#stepIn(delivery.moveId, {
        event: "add",
        task: {
          ...delivery.task,
          assignee: actor.kind === "personal" ? null : delivery.task.assignee,
          moving: null,
        },
      });
      return { status: "added" };
    });
  }

  // The sender has deleted its own, so the copy becomes an ordinary task.
  unlockMoveIn(moveId: string): void {
    this.#db.transaction(() => this.#stepIn(moveId, { event: "unlock" }));
  }

  // The sender kept the task. A move this board never heard of is remembered as dropped,
  // in case its delivery is still on the way.
  dropMoveIn(moveId: string): void {
    this.#db.transaction(() => this.#stepIn(moveId, { event: "drop" }));
  }

  // Removes for good every task whose Undo has passed. Running it again changes nothing.
  purgeDeleted(now: number): void {
    this.#db.exec(
      "DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at <= ?",
      now - UNDO_DELETE_MS,
    );
  }

  nextWakeUpAt(): number | null {
    const [row] = this.#rows<{ purge: number | null; move: number | null }>(
      `SELECT
         (SELECT MIN(deleted_at) FROM tasks WHERE deleted_at IS NOT NULL) AS purge,
         (SELECT MIN(try_at) FROM moves_out) AS move`,
    );
    const due = [
      row?.purge == null ? null : row.purge + UNDO_DELETE_MS,
      row?.move ?? null,
    ].filter((at): at is number => at !== null);
    return due.length > 0 ? Math.min(...due) : null;
  }
}
