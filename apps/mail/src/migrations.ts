import type { SqlDriver } from "./sql";

// Append only: a mailbox that ran a migration never runs it again, so editing
// one would leave mailboxes with different schemas. Add a new entry instead.
// migrations.test.ts pins the digest of every entry.
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL
    )`,
    // Every RFC Message-ID a thread's messages carry or point at. A reference
    // to a message that has not arrived yet is what lets it find its thread.
    `CREATE TABLE thread_refs (
      rfc_id TEXT PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE
    ) WITHOUT ROWID`,
    `CREATE INDEX thread_refs_thread ON thread_refs(thread_id)`,
    `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_hash TEXT NOT NULL UNIQUE,
      raw_size INTEGER NOT NULL,
      r2_prefix TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('inbound', 'import', 'sent')),
      envelope_from TEXT,
      envelope_to TEXT,
      parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed', 'failed')),
      rfc_message_id TEXT,
      refs TEXT NOT NULL,
      thread_id INTEGER NOT NULL REFERENCES threads(id),
      from_name TEXT,
      from_address TEXT,
      reply_to TEXT NOT NULL,
      to_addresses TEXT NOT NULL,
      cc_addresses TEXT NOT NULL,
      participants TEXT NOT NULL,
      subject TEXT,
      normalized_subject TEXT NOT NULL,
      is_orphan_reply INTEGER NOT NULL CHECK (is_orphan_reply IN (0, 1)),
      snippet TEXT NOT NULL,
      sent_at INTEGER,
      received_at INTEGER NOT NULL,
      thread_date INTEGER NOT NULL,
      is_read INTEGER NOT NULL CHECK (is_read IN (0, 1)),
      is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
      folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'drafts', 'spam', 'trash', 'archive')),
      has_attachments INTEGER NOT NULL CHECK (has_attachments IN (0, 1)),
      auth_results TEXT
    )`,
    `CREATE INDEX messages_thread ON messages(thread_id, thread_date, id)`,
    `CREATE INDEX messages_subject_window ON messages(normalized_subject, thread_date) WHERE normalized_subject <> ''`,
    `CREATE TABLE message_bodies (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'html')),
      inline_content TEXT,
      r2_key TEXT,
      size INTEGER NOT NULL,
      PRIMARY KEY (message_id, kind),
      CHECK ((inline_content IS NULL) <> (r2_key IS NULL))
    )`,
    `CREATE TABLE attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      filename TEXT,
      mime_type TEXT NOT NULL,
      is_inline INTEGER NOT NULL CHECK (is_inline IN (0, 1)),
      content_id TEXT,
      size INTEGER NOT NULL,
      r2_key TEXT NOT NULL,
      UNIQUE (message_id, position)
    )`,
    `CREATE TABLE labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE message_labels (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, label_id)
    ) WITHOUT ROWID`,
    `CREATE INDEX message_labels_label ON message_labels(label_id)`,
    `CREATE TABLE rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      conditions TEXT NOT NULL,
      actions TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    // The read model behind every folder and label list, one row per thread per
    // view, so paging a large folder never scans or groups its messages.
    `CREATE TABLE thread_views (
      view TEXT NOT NULL,
      thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      last_at INTEGER NOT NULL,
      subject TEXT,
      snippet TEXT NOT NULL,
      senders TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      unread_count INTEGER NOT NULL,
      is_starred INTEGER NOT NULL,
      has_attachments INTEGER NOT NULL,
      PRIMARY KEY (view, thread_id)
    ) WITHOUT ROWID`,
    `CREATE INDEX thread_views_page ON thread_views(view, last_at DESC, thread_id DESC)`,
    `CREATE INDEX thread_views_thread ON thread_views(thread_id)`,
    // Removing rows and removing R2 objects cannot share a transaction, so the
    // rows go first and this queue carries the rest across a crash. An upload
    // that lost a duplicate race or failed partway queues its objects here too.
    `CREATE TABLE r2_deletions (
      prefix TEXT PRIMARY KEY,
      queued_at INTEGER NOT NULL
    ) WITHOUT ROWID`,
    // Contentless because the text is already in message_bodies or R2. A copy
    // here would double storage and could pass the 2 MB row limit.
    `CREATE VIRTUAL TABLE message_search USING fts5(
      subject, sender, recipients, body,
      content = '', contentless_delete = 1,
      tokenize = 'unicode61 remove_diacritics 2'
    )`,
    `CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
      DELETE FROM message_search WHERE rowid = old.id;
    END`,
  ],
  [
    // When a queued prefix may go. Objects still being written get a delay, and
    // the alarm can now fire early for other work, so the delay has to be stored.
    `ALTER TABLE r2_deletions ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE import_jobs (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('uploading', 'queued', 'running', 'done', 'failed', 'cancelled')),
      file_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      -- Not null while R2 holds an unfinished upload that someone must complete or abort.
      upload_id TEXT,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      skipping TEXT,
      stored_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      unreadable_count INTEGER NOT NULL DEFAULT 0,
      -- Set before a batch writes to R2 and cleared by the transaction that saves it,
      -- so finding it set means the last batch died, and names the objects it left.
      attempt TEXT,
      crashes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER,
      failure TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    )`,
    `CREATE INDEX import_jobs_due ON import_jobs(next_run_at) WHERE next_run_at IS NOT NULL`,
    // The R2 binding cannot list a multipart upload's parts, so they are kept here.
    `CREATE TABLE import_parts (
      job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
      part_number INTEGER NOT NULL,
      etag TEXT NOT NULL,
      PRIMARY KEY (job_id, part_number)
    ) WITHOUT ROWID`,
    `CREATE TABLE import_unreadable (
      job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
      byte_offset INTEGER NOT NULL,
      size INTEGER NOT NULL,
      reason TEXT NOT NULL,
      hint TEXT NOT NULL,
      PRIMARY KEY (job_id, byte_offset)
    ) WITHOUT ROWID`,
  ],
  // The sidebar's unread counts refresh all day, so they read only unread rows
  // and never scan a large folder.
  [
    `CREATE INDEX thread_views_unread ON thread_views(view) WHERE unread_count > 0`,
  ],
  // A role from the theme, not a colour, so editing the theme recolours labels too.
  [`ALTER TABLE labels ADD COLUMN colour TEXT NOT NULL DEFAULT 'secondary'`],
];

export function applyMigrations(
  db: SqlDriver,
  migrations: readonly (readonly string[])[] = MIGRATIONS,
): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
    const [latest] = db
      .exec<{ version: number | null }>(
        "SELECT MAX(version) AS version FROM schema_migrations",
      )
      .toArray();
    migrations.slice(latest?.version ?? 0).forEach((statements, index) => {
      for (const statement of statements) db.exec(statement);
      db.exec(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        (latest?.version ?? 0) + index + 1,
        Date.now(),
      );
    });
  });
}
