import type { Migrations } from "@cloudysuite/object-sql";

// Append only. Add a new entry instead of editing one: migrations.test.ts pins the
// digest of every entry.
export const MIGRATIONS: Migrations = [
  [
    // A deleted task keeps its row until Undo has passed, then the alarm removes it.
    `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      assignee_id TEXT,
      assignee_name TEXT,
      due TEXT,
      notes TEXT NOT NULL,
      checklist TEXT NOT NULL,
      created_by_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      done_at INTEGER,
      deleted_at INTEGER,
      CHECK (status IN ('todo', 'doing', 'done')),
      CHECK ((assignee_id IS NULL) = (assignee_name IS NULL)),
      CHECK ((done_at IS NOT NULL) = (status = 'done'))
    )`,
    `CREATE INDEX tasks_deleted ON tasks(deleted_at) WHERE deleted_at IS NOT NULL`,
  ],
  [
    // A task is locked while a locked move names it, so nothing else marks the lock. The
    // states and their steps are in moves.ts. `task` is the task as it will arrive.
    `CREATE TABLE moves_out (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      to_board_id TEXT NOT NULL,
      to_kind TEXT NOT NULL,
      to_name TEXT NOT NULL,
      moved_by TEXT NOT NULL,
      phase TEXT NOT NULL,
      task TEXT NOT NULL,
      try_at INTEGER NOT NULL,
      give_up_at INTEGER NOT NULL,
      CHECK (phase IN ('locked', 'added', 'givenUp')),
      CHECK (to_kind IN ('personal', 'team'))
    )`,
    `CREATE UNIQUE INDEX moves_out_one_lock ON moves_out(task_id) WHERE phase = 'locked'`,
    `CREATE INDEX moves_out_due ON moves_out(try_at)`,
    // Every move this board has heard of stays, so a late repeat of a finished or dropped
    // one adds nothing. A locked copy is held here, out of every list, until it's unlocked.
    `CREATE TABLE moves_in (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      phase TEXT NOT NULL,
      task TEXT,
      CHECK (phase IN ('locked', 'unlocked', 'dropped')),
      CHECK ((task IS NOT NULL) = (phase = 'locked'))
    ) WITHOUT ROWID`,
    `CREATE UNIQUE INDEX moves_in_one_arrival ON moves_in(task_id) WHERE phase = 'locked'`,
  ],
  [
    // Contentless because tasks already holds the text, as Calendar's event_search.
    // Triggers keep it in the same transaction as every change to tasks. A task's rowid
    // lasts its whole life: only VACUUM renumbers, and nothing here runs it.
    `CREATE VIRTUAL TABLE task_search USING fts5(
      title, notes,
      content = '', contentless_delete = 1,
      tokenize = 'unicode61 remove_diacritics 2',
      prefix = '2 3'
    )`,
    `INSERT INTO task_search (rowid, title, notes)
     SELECT rowid, title, notes FROM tasks`,
    `CREATE TRIGGER tasks_search_insert AFTER INSERT ON tasks BEGIN
      INSERT INTO task_search (rowid, title, notes)
      VALUES (new.rowid, new.title, new.notes);
    END`,
    `CREATE TRIGGER tasks_search_change AFTER UPDATE OF title, notes ON tasks
    WHEN old.title <> new.title OR old.notes <> new.notes
    BEGIN
      DELETE FROM task_search WHERE rowid = old.rowid;
      INSERT INTO task_search (rowid, title, notes)
      VALUES (new.rowid, new.title, new.notes);
    END`,
    `CREATE TRIGGER tasks_search_delete AFTER DELETE ON tasks BEGIN
      DELETE FROM task_search WHERE rowid = old.rowid;
    END`,
  ],
  [
    // One row for each task whose assignee is due an email, replaced by each new
    // assignment. The states and their steps are in email/queue.ts.
    `CREATE TABLE assignment_emails (
      task_id TEXT PRIMARY KEY,
      email_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      assignee_id TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      tries INTEGER NOT NULL,
      try_at INTEGER,
      CHECK (state IN ('waiting', 'sending', 'sent', 'notSent', 'unclear')),
      CHECK ((try_at IS NULL) = (state NOT IN ('waiting', 'sending'))),
      CHECK ((reason IS NULL) = (state != 'notSent'))
    ) WITHOUT ROWID`,
    `CREATE INDEX assignment_emails_due ON assignment_emails(try_at)
     WHERE try_at IS NOT NULL`,
    // In the same transaction as whatever removes the task: a purge, a move, or erasing.
    `CREATE TRIGGER tasks_email_delete AFTER DELETE ON tasks BEGIN
      DELETE FROM assignment_emails WHERE task_id = old.id;
    END`,
  ],
  [
    // For the reads of one person's tasks: My tasks, Calendar's due tasks, and a person's
    // open tasks in search. done_at is null exactly while a task is open.
    `CREATE INDEX tasks_mine ON tasks(assignee_id, done_at, due)
     WHERE deleted_at IS NULL`,
  ],
  [
    // Written in the transaction that unlocks the task, so a retry can't lose or repeat
    // it. index_due_at says D1 still needs telling, and what to write is read from
    // dismissed when the write runs. A dismissed row goes once D1 has dropped it.
    `CREATE TABLE move_notices (
      move_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      to_kind TEXT NOT NULL,
      to_name TEXT NOT NULL,
      setback TEXT NOT NULL,
      noted_at INTEGER NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      index_due_at INTEGER,
      CHECK (to_kind IN ('personal', 'team')),
      CHECK (setback IN ('noAccess', 'busy', 'dropped', 'noAnswer')),
      CHECK (dismissed IN (0, 1))
    ) WITHOUT ROWID`,
    `CREATE INDEX move_notices_for_person ON move_notices(user_id, noted_at)`,
    `CREATE INDEX move_notices_due ON move_notices(index_due_at)
     WHERE index_due_at IS NOT NULL`,
  ],
];
