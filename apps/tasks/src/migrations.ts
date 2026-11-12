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
];
