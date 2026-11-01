import type { Migrations } from "@cloudysuite/object-sql";

// Append only. Add a new entry instead of editing one: migrations.test.ts pins the
// digest of every entry.
export const MIGRATIONS: Migrations = [
  [
    `CREATE TABLE items (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES items(id),
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      size INTEGER,
      mime_type TEXT,
      r2_key TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      changed_at INTEGER NOT NULL,
      CHECK (
        (kind = 'folder' AND size IS NULL AND mime_type IS NULL AND r2_key IS NULL) OR
        (kind = 'file' AND size IS NOT NULL AND mime_type IS NOT NULL AND r2_key IS NOT NULL)
      )
    )`,
    `CREATE UNIQUE INDEX items_one_path ON items(coalesce(parent_id, ''), name_key)`,
    `CREATE INDEX items_listing ON items(coalesce(parent_id, ''), kind, name_key)`,
    `CREATE INDEX items_recent_files ON items(changed_at) WHERE kind = 'file'`,
    // A person can pick the same file again in the same folder, and this row finds it.
    // The fingerprint keeps a different file with the same name and size from being
    // joined to the parts of the first.
    `CREATE TABLE uploads (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES items(id),
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      r2_upload_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      touched_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX uploads_resume ON uploads(coalesce(parent_id, ''), name, size, fingerprint, created_by)`,
    `CREATE INDEX uploads_touched ON uploads(touched_at)`,
    // R2 can't list a multipart upload's parts, and finishing one needs every etag.
    `CREATE TABLE upload_parts (
      upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      part_number INTEGER NOT NULL,
      etag TEXT NOT NULL,
      PRIMARY KEY (upload_id, part_number)
    ) WITHOUT ROWID`,
    // sync_due_at is the dirty flag for D1's copy. It goes in the same transaction as
    // the change, so a crash before the write still leaves the retry.
    `CREATE TABLE drive_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      drive_id TEXT NOT NULL,
      used_bytes INTEGER NOT NULL,
      file_count INTEGER NOT NULL,
      changed_at INTEGER NOT NULL,
      sync_due_at INTEGER
    )`,
  ],
];
