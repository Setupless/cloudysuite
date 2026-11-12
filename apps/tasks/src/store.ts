import {
  type BoardId,
  type BoardKind,
  type BoardRole,
  levelOfRole,
  type UserId,
} from "@cloudysuite/access";
import type { SqlDriver } from "@cloudysuite/object-sql";
import { type SearchTerm, toPrefixMatch } from "@cloudysuite/search";
import {
  EMAIL_STEPS,
  type EmailEvent,
  type EmailState,
  type QueuedEmail,
} from "./email/queue";
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
  ASSIGNMENT_EMAIL_WAIT_MS,
  type AssignmentEmailStatus,
  type BoardMoveNotice,
  type ChangeResult,
  type ChecklistItem,
  LIMITS,
  type MoveDestination,
  type MoveOutcome,
  type MoveSetback,
  type NotEmailedReason,
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

const TASKS_PER_SEARCH = 50;

// A claim found still sending after this came from a run that never finished.
const SENDING_CHECK_MS = 60_000;

export const NOTICE_INDEX_RETRY_MS = 60_000;

type EmailRow = {
  task_id: string;
  email_id: string;
  board_id: string;
  assignee_id: string;
  assigned_by: string;
  state: string;
  reason: string | null;
  tries: number;
};

// What D1's board_move_notices is still to be told about one note.
export type NoticeIndexWrite = {
  moveId: string;
  userId: UserId;
  present: boolean;
};

// Whoever asks for their own notes, whether or not they can still open the board.
export type NoticeReader = { userId: UserId; canOpen: boolean };

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

// Whose tasks My tasks lists here. Nobody can be assigned a task on a personal board, so
// there it's the tasks with no assignee, which is all of them.
const mineAssignee = (actor: Actor): UserId | null =>
  actor.kind === "personal" ? null : actor.userId;

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
  // assigned to the person asking. Written as two whole branches so each one is a
  // search of tasks_mine.
  listMine(actor: Actor, doneSince: number): Task[] {
    const assignee = mineAssignee(actor);
    return this.#rows<TaskRow>(
      `${TASKS}
       WHERE (deleted_at IS NULL AND assignee_id IS ? AND done_at IS NULL)
          OR (deleted_at IS NULL AND assignee_id IS ? AND done_at >= ?)
       ORDER BY created_at, tasks.id`,
      assignee,
      assignee,
      doneSince,
    ).map(taskOf);
  }

  // Of every task here, the open ones assigned to someone, for their tasks page.
  listOpenFor(_actor: Actor, assigneeId: UserId): Task[] {
    return this.#rows<TaskRow>(
      `${TASKS}
       WHERE deleted_at IS NULL AND done_at IS NULL AND assignee_id = ?
       ORDER BY created_at, tasks.id`,
      assigneeId,
    ).map(taskOf);
  }

  // Leaves out a deleted task and one on its way out. When more match than one answer
  // holds, the ones kept are those search lists first.
  search(
    _actor: Actor,
    terms: readonly SearchTerm[],
  ): { tasks: Task[]; more: boolean } {
    const expression = toPrefixMatch(terms);
    if (expression === null) return { tasks: [], more: false };
    const rows = this.#rows<TaskRow>(
      `${TASKS}
       WHERE tasks.deleted_at IS NULL AND moves_out.id IS NULL
         AND tasks.rowid IN (
           SELECT rowid FROM task_search WHERE task_search MATCH ?
         )
       ORDER BY status = 'done', CASE WHEN status = 'done' THEN -done_at END,
         due IS NULL, due, created_at DESC, tasks.id
       LIMIT ?`,
      expression,
      TASKS_PER_SEARCH + 1,
    );
    return {
      tasks: rows.slice(0, TASKS_PER_SEARCH).map(taskOf),
      more: rows.length > TASKS_PER_SEARCH,
    };
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
      this.#assigned(
        actor,
        next.id,
        row.assignee_id as UserId | null,
        next.assignee?.id ?? null,
        now,
      );
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
    this.#assigned(actor, task.id, null, task.assignee?.id ?? null, now);
    return { status: "done", task };
  }

  // In the same transaction as the assignment. A new assignee replaces whatever email
  // was due before, so someone reassigned within the wait gets nothing. Nobody is
  // emailed about a task they assigned themselves.
  #assigned(
    actor: Actor,
    id: TaskId,
    before: UserId | null,
    after: UserId | null,
    now: number,
  ): void {
    if (before === after) return;
    if (after === null || after === actor.userId) {
      this.#db.exec("DELETE FROM assignment_emails WHERE task_id = ?", id);
      return;
    }
    this.#db.exec(
      `INSERT INTO assignment_emails (task_id, email_id, board_id, assignee_id,
         assigned_by, state, reason, tries, try_at)
       VALUES (?, ?, ?, ?, ?, 'waiting', NULL, 0, ?)
       ON CONFLICT (task_id) DO UPDATE SET email_id = excluded.email_id,
         board_id = excluded.board_id, assignee_id = excluded.assignee_id,
         assigned_by = excluded.assigned_by, state = 'waiting', reason = NULL,
         tries = 0, try_at = excluded.try_at`,
      id,
      crypto.randomUUID(),
      actor.boardId,
      after,
      actor.userId,
      now + ASSIGNMENT_EMAIL_WAIT_MS,
    );
  }

  dueEmails(now: number, limit: number): QueuedEmail[] {
    return this.#rows<EmailRow>(
      `SELECT * FROM assignment_emails WHERE try_at <= ? ORDER BY try_at LIMIT ?`,
      now,
      limit,
    ).map((row) => ({
      emailId: row.email_id,
      taskId: row.task_id as TaskId,
      boardId: row.board_id as BoardId,
      assigneeId: row.assignee_id as UserId,
      assignedBy: row.assigned_by as UserId,
      state: row.state === "sending" ? "sending" : "waiting",
      tries: row.tries,
    }));
  }

  // The task an email is about, deleted or not, for the checks before it goes.
  emailTask(id: TaskId): { task: Task; deletedAt: number | null } | null {
    const row = this.#row(id);
    return row ? { task: taskOf(row), deletedAt: row.deleted_at } : null;
  }

  // Every change to a queued email goes through here. False when its state doesn't
  // allow the step, or a newer assignment has replaced it.
  stepEmail(
    queued: Pick<QueuedEmail, "taskId" | "emailId">,
    event: EmailEvent,
    now: number,
    detail: { reason?: NotEmailedReason; tryAt?: number } = {},
  ): boolean {
    return this.#db.transaction(() =>
      this.#stepEmail(queued, event, now, detail),
    );
  }

  #stepEmail(
    queued: Pick<QueuedEmail, "taskId" | "emailId">,
    event: EmailEvent,
    now: number,
    detail: { reason?: NotEmailedReason; tryAt?: number },
  ): boolean {
    const [row] = this.#rows<{ state: string }>(
      "SELECT state FROM assignment_emails WHERE task_id = ? AND email_id = ?",
      queued.taskId,
      queued.emailId,
    );
    const next = row && EMAIL_STEPS[row.state as EmailState][event];
    if (!next) return false;
    if (next === "dropped") {
      this.#db.exec(
        "DELETE FROM assignment_emails WHERE task_id = ?",
        queued.taskId,
      );
      return true;
    }
    const tryAt =
      next === "sending"
        ? now + SENDING_CHECK_MS
        : next === "waiting"
          ? (detail.tryAt ?? now)
          : null;
    this.#db.exec(
      `UPDATE assignment_emails SET state = ?, reason = ?, try_at = ?,
         tries = CASE ? WHEN 'tryLater' THEN tries + 1 ELSE tries END
       WHERE task_id = ?`,
      next,
      next === "notSent" ? (detail.reason ?? "invalidMessage") : null,
      tryAt,
      event,
      queued.taskId,
    );
    return true;
  }

  // Only an email that didn't go, or may not have, as the steps allow. One on its way or
  // gone is left as it is, so pressing it twice sends once. It then goes from whoever
  // chose it, who must be able to edit the board, and never to themselves.
  retryEmail(actor: Actor, id: TaskId, now: number): "done" | "noAccess" {
    if (levelOfRole(actor.role) !== "edit") return "noAccess";
    this.#db.transaction(() => {
      const [row] = this.#rows<{ email_id: string; assignee_id: string }>(
        "SELECT email_id, assignee_id FROM assignment_emails WHERE task_id = ?",
        id,
      );
      if (!row || row.assignee_id === actor.userId) return;
      if (
        !this.#stepEmail(
          { taskId: id, emailId: row.email_id },
          "retry",
          now,
          {},
        )
      ) {
        return;
      }
      this.#db.exec(
        `UPDATE assignment_emails SET email_id = ?, tries = 0 WHERE task_id = ?`,
        crypto.randomUUID(),
        id,
      );
    });
    return "done";
  }

  emailStatus(_actor: Actor, id: TaskId): AssignmentEmailStatus {
    const [row] = this.#rows<{ state: string; reason: string | null }>(
      `SELECT assignment_emails.state, assignment_emails.reason
       FROM assignment_emails JOIN tasks ON tasks.id = assignment_emails.task_id
       WHERE task_id = ? AND tasks.assignee_id = assignment_emails.assignee_id`,
      id,
    );
    if (!row) return { state: "none" };
    const state = row.state as EmailState;
    switch (state) {
      case "notSent":
        return { state, reason: row.reason as NotEmailedReason };
      case "waiting":
      case "sending":
        return { state: "pending" };
      case "sent":
      case "unclear":
        return { state };
    }
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
      this.#db.exec("DELETE FROM move_notices");
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
  // changes nothing, so a late or repeated answer can't undo a later one. A note goes in
  // with the step that unlocks the task, so it's written once or not at all.
  advanceOut(
    moveId: string,
    event: OutgoingEvent,
    tryAt: number,
    note: { setback: MoveSetback; now: number } | null = null,
  ): void {
    this.#db.transaction(() => {
      const [move] = this.#rows<{ phase: string; task_id: string }>(
        "SELECT phase, task_id FROM moves_out WHERE id = ?",
        moveId,
      );
      const next = move && OUTGOING_STEPS[move.phase as OutgoingPhase][event];
      if (!move || !next) return;
      if (note) this.#noteSetback(moveId, note.setback, note.now);
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

  #noteSetback(moveId: string, setback: MoveSetback, now: number): void {
    this.#db.exec(
      `INSERT INTO move_notices (move_id, user_id, title, to_kind, to_name, setback,
         noted_at, index_due_at)
       SELECT id, moved_by, json_extract(task, '$.title'), to_kind, to_name, ?, ?, ?
       FROM moves_out WHERE id = ?
       ON CONFLICT (move_id) DO NOTHING`,
      setback,
      now,
      now,
      moveId,
    );
  }

  moveNotices(reader: NoticeReader): BoardMoveNotice[] {
    return this.#rows<{
      move_id: string;
      title: string;
      to_kind: string;
      to_name: string;
      setback: string;
      noted_at: number;
    }>(
      `SELECT move_id, title, to_kind, to_name, setback, noted_at FROM move_notices
       WHERE user_id = ? AND dismissed = 0 ORDER BY noted_at DESC`,
      reader.userId,
    ).map((row) => ({
      moveId: row.move_id,
      title: reader.canOpen ? row.title : null,
      to: { kind: row.to_kind as MoveDestination["kind"], name: row.to_name },
      setback: row.setback as MoveSetback,
      notedAt: row.noted_at,
    }));
  }

  // Only the person it's for can dismiss it, and doing it twice changes nothing.
  dismissMoveNotice(reader: NoticeReader, moveId: string, now: number): void {
    this.#db.exec(
      `UPDATE move_notices SET dismissed = 1, index_due_at = ?
       WHERE move_id = ? AND user_id = ? AND dismissed = 0`,
      now,
      moveId,
      reader.userId,
    );
  }

  noticeIndexWrites(now: number, limit: number): NoticeIndexWrite[] {
    return this.#rows<{
      move_id: string;
      user_id: string;
      dismissed: number;
    }>(
      `SELECT move_id, user_id, dismissed FROM move_notices
       WHERE index_due_at <= ? ORDER BY index_due_at LIMIT ?`,
      now,
      limit,
    ).map((row) => ({
      moveId: row.move_id,
      userId: row.user_id as UserId,
      present: row.dismissed === 0,
    }));
  }

  // A dismissal made while the write was on its way no longer matches, so it stays due.
  finishNoticeIndexWrites(written: readonly NoticeIndexWrite[]): void {
    this.#db.transaction(() => {
      for (const { moveId, present } of written) {
        this.#db.exec(
          present
            ? "UPDATE move_notices SET index_due_at = NULL WHERE move_id = ? AND dismissed = 0"
            : "DELETE FROM move_notices WHERE move_id = ? AND dismissed = 1",
          moveId,
        );
      }
    });
  }

  postponeNoticeIndexWrites(retryAt: number): void {
    this.#db.exec(
      "UPDATE move_notices SET index_due_at = ? WHERE index_due_at IS NOT NULL",
      retryAt,
    );
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
    const [row] = this.#rows<{
      purge: number | null;
      move: number | null;
      email: number | null;
      notice: number | null;
    }>(
      `SELECT
         (SELECT MIN(deleted_at) FROM tasks WHERE deleted_at IS NOT NULL) AS purge,
         (SELECT MIN(try_at) FROM moves_out) AS move,
         (SELECT MIN(try_at) FROM assignment_emails) AS email,
         (SELECT MIN(index_due_at) FROM move_notices) AS notice`,
    );
    const due = [
      row?.purge == null ? null : row.purge + UNDO_DELETE_MS,
      row?.move ?? null,
      row?.email ?? null,
      row?.notice ?? null,
    ].filter((at): at is number => at !== null);
    return due.length > 0 ? Math.min(...due) : null;
  }
}
