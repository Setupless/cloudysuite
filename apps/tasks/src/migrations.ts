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
];
