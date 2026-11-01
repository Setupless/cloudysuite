import type { DriveId, UserId } from "@cloudysuite/access";
import type { SqlDriver, SqlRow, SqlValue } from "@cloudysuite/object-sql";
import { partCountFor } from "@cloudysuite/transfer";
import { nameKeyOf, numberedName, type ParsedName } from "./names";
import type {
  DriveItem,
  FileItem,
  FolderItem,
  FolderListing,
  ItemId,
  NewFolderResult,
  UploadView,
} from "./types";

export const UPLOAD_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;
export const USAGE_RETRY_MS = 60_000;
const PAGE_SIZE = 200;

type ItemRow = SqlRow & {
  id: string;
  parent_id: string | null;
  kind: "folder" | "file";
  name: string;
  size: number | null;
  mime_type: string | null;
  created_by: string;
  created_at: number;
  changed_at: number;
  contains: number;
};

type UploadRow = SqlRow & {
  id: string;
  parent_id: string | null;
  name: string;
  size: number;
  mime_type: string;
  r2_key: string;
  r2_upload_id: string;
  created_by: string;
};

const SELECT_ITEMS = `SELECT items.*,
  (SELECT count(*) FROM items AS child WHERE coalesce(child.parent_id, '') = items.id) AS contains
  FROM items`;

function parseItem(row: ItemRow): DriveItem {
  const fields = {
    id: row.id as ItemId,
    parentId: row.parent_id as ItemId | null,
    name: row.name,
    createdBy: row.created_by as UserId,
    createdAt: row.created_at,
    changedAt: row.changed_at,
  };
  switch (row.kind) {
    case "folder":
      return { ...fields, kind: "folder", contains: row.contains };
    case "file":
      return {
        ...fields,
        kind: "file",
        size: row.size as number,
        mimeType: row.mime_type as string,
      };
  }
}

const CHAIN = `WITH RECURSIVE chain(id, parent_id, depth) AS (
  SELECT id, parent_id, 0 FROM items WHERE id = ?
  UNION ALL
  SELECT items.id, items.parent_id, chain.depth + 1
  FROM items JOIN chain ON items.id = chain.parent_id
)`;

// The cursor is the kind and name_key of the last row sent. Folders sort first, which
// is what kind's descending order gives.
const encodeCursor = (kind: string, nameKey: string) => `${kind}:${nameKey}`;
function decodeCursor(cursor: string): [kind: string, nameKey: string] {
  const colon = cursor.indexOf(":");
  return [cursor.slice(0, colon), cursor.slice(colon + 1)];
}

export type Usage = {
  driveId: DriveId;
  usedBytes: number;
  fileCount: number;
  changedAt: number;
};

export type NewUpload = {
  id: ItemId;
  parentId: ItemId | null;
  name: string;
  size: number;
  mimeType: string;
  fingerprint: string;
  r2Key: string;
  r2UploadId: string;
  createdBy: UserId;
};

export type FoundUpload = {
  parentId: ItemId | null;
  name: string;
  size: number;
  fingerprint: string;
  createdBy: UserId;
};

export type PartPlan =
  | { status: "finished" }
  | { status: "unknown" }
  | { status: "badPartNumber" }
  | { status: "stored" }
  | {
      status: "needed";
      size: number;
      r2Key: string;
      r2UploadId: string;
    };

export type CompletionPlan =
  | { status: "finished"; item: FileItem }
  | { status: "unknown" }
  | {
      status: "ready";
      size: number;
      r2Key: string;
      r2UploadId: string;
      parts: { partNumber: number; etag: string }[];
    };

export type CommitResult =
  { status: "committed"; item: FileItem } | { status: "unknown" };

export type StaleUpload = { id: string; r2Key: string; r2UploadId: string };

export class DriveStore {
  readonly #db: SqlDriver;

  constructor(db: SqlDriver) {
    this.#db = db;
  }

  #rows<Row extends SqlRow>(query: string, ...bindings: SqlValue[]): Row[] {
    return this.#db.exec<Row>(query, ...bindings).toArray();
  }

  item(id: ItemId): DriveItem | null {
    const [row] = this.#rows<ItemRow>(`${SELECT_ITEMS} WHERE items.id = ?`, id);
    return row ? parseItem(row) : null;
  }

  #folder(id: ItemId): FolderItem | null {
    const item = this.item(id);
    return item?.kind === "folder" ? item : null;
  }

  file(id: ItemId): FileItem | null {
    const item = this.item(id);
    return item?.kind === "file" ? item : null;
  }

  // Null when the folder doesn't exist, so a bad link can't look like an empty folder.
  list(parentId: ItemId | null, cursor: string | null): FolderListing | null {
    const folder = parentId === null ? null : this.#folder(parentId);
    if (parentId !== null && folder === null) return null;

    const after = cursor ? decodeCursor(cursor) : null;
    const rows = this.#rows<ItemRow>(
      `${SELECT_ITEMS}
       WHERE coalesce(items.parent_id, '') = ?
       ${after ? "AND (items.kind < ? OR (items.kind = ? AND items.name_key > ?))" : ""}
       ORDER BY items.kind DESC, items.name_key
       LIMIT ?`,
      parentId ?? "",
      ...(after ? [after[0], after[0], after[1]] : []),
      PAGE_SIZE + 1,
    );
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      folder,
      ancestors: parentId === null ? [] : this.#ancestors(parentId),
      contains: folder
        ? folder.contains
        : (this.#rows<{ total: number }>(
            "SELECT count(*) AS total FROM items WHERE coalesce(parent_id, '') = ''",
          )[0]?.total ?? 0),
      items: page.map(parseItem),
      nextCursor:
        rows.length > PAGE_SIZE && last
          ? encodeCursor(last.kind, nameKeyOf(last.name))
          : null,
    };
  }

  #ancestors(id: ItemId): FolderItem[] {
    return this.#rows<ItemRow>(
      `${CHAIN}
       SELECT items.*, 0 AS contains FROM items JOIN chain ON items.id = chain.id
       WHERE chain.depth > 0 ORDER BY chain.depth DESC`,
      id,
    ).map(parseItem) as FolderItem[];
  }

  recent(limit: number): FileItem[] {
    return this.#rows<ItemRow>(
      `SELECT items.*, 0 AS contains FROM items WHERE kind = 'file'
       ORDER BY changed_at DESC, id LIMIT ?`,
      limit,
    ).map(parseItem) as FileItem[];
  }

  #nameIsFree(parentId: ItemId | null, nameKey: string): boolean {
    return (
      this.#rows(
        "SELECT 1 AS found FROM items WHERE coalesce(parent_id, '') = ? AND name_key = ?",
        parentId ?? "",
        nameKey,
      ).length === 0
    );
  }

  #touchChain(parentId: ItemId | null, now: number): void {
    if (parentId === null) return;
    this.#db.exec(
      `${CHAIN} UPDATE items SET changed_at = ? WHERE id IN (SELECT id FROM chain)`,
      parentId,
      now,
    );
  }

  #noteChange(
    driveId: DriveId,
    addedBytes: number,
    addedFiles: number,
    now: number,
  ) {
    this.#db.exec(
      `INSERT INTO drive_state (id, drive_id, used_bytes, file_count, changed_at, sync_due_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         used_bytes = used_bytes + excluded.used_bytes,
         file_count = file_count + excluded.file_count,
         changed_at = excluded.changed_at,
         sync_due_at = excluded.sync_due_at`,
      driveId,
      addedBytes,
      addedFiles,
      now,
      now + USAGE_RETRY_MS,
    );
  }

  createFolder(input: {
    driveId: DriveId;
    id: ItemId;
    parentId: ItemId | null;
    name: Extract<ParsedName, { ok: true }>;
    createdBy: UserId;
    now: number;
  }): NewFolderResult {
    const { driveId, id, parentId, name, createdBy, now } = input;
    return this.#db.transaction((): NewFolderResult => {
      if (parentId !== null && !this.#folder(parentId)) {
        return { status: "noParent" };
      }
      if (!this.#nameIsFree(parentId, name.nameKey)) {
        return { status: "nameTaken" };
      }
      this.#db.exec(
        `INSERT INTO items (id, parent_id, kind, name, name_key, created_by, created_at, changed_at)
         VALUES (?, ?, 'folder', ?, ?, ?, ?, ?)`,
        id,
        parentId,
        name.name,
        name.nameKey,
        createdBy,
        now,
        now,
      );
      this.#touchChain(parentId, now);
      this.#noteChange(driveId, 0, 0, now);
      return { status: "created", item: this.#folder(id) as FolderItem };
    });
  }

  folderExists(id: ItemId): boolean {
    return this.#folder(id) !== null;
  }

  #uploadView(row: UploadRow): UploadView {
    return {
      id: row.id as ItemId,
      name: row.name,
      size: row.size,
      storedParts: this.#rows<{ part_number: number }>(
        "SELECT part_number FROM upload_parts WHERE upload_id = ? ORDER BY part_number",
        row.id,
      ).map((part) => part.part_number),
    };
  }

  // Finding it counts as activity, so someone coming back isn't swept while resuming.
  findUpload(found: FoundUpload, now: number): UploadView | null {
    const [row] = this.#rows<UploadRow>(
      `SELECT * FROM uploads
       WHERE closing = 0 AND coalesce(parent_id, '') = ? AND name = ? AND size = ? AND fingerprint = ? AND created_by = ?`,
      found.parentId ?? "",
      found.name,
      found.size,
      found.fingerprint,
      found.createdBy,
    );
    if (!row) return null;
    this.#db.exec(
      "UPDATE uploads SET touched_at = ? WHERE id = ?",
      now,
      row.id,
    );
    return this.#uploadView(row);
  }

  // Two tabs can race here. The loser's upload is returned as "lost", for its caller to
  // abort, and both tabs carry on sending to the one that stayed.
  createUpload(
    upload: NewUpload,
    now: number,
  ): { status: "created" | "lost"; upload: UploadView } {
    return this.#db.transaction(() => {
      const existing = this.findUpload(upload, now);
      if (existing) return { status: "lost" as const, upload: existing };
      this.#db.exec(
        `INSERT INTO uploads (id, parent_id, name, size, mime_type, fingerprint, r2_key, r2_upload_id, created_by, created_at, touched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        upload.id,
        upload.parentId,
        upload.name,
        upload.size,
        upload.mimeType,
        upload.fingerprint,
        upload.r2Key,
        upload.r2UploadId,
        upload.createdBy,
        now,
        now,
      );
      return {
        status: "created" as const,
        upload: {
          id: upload.id,
          name: upload.name,
          size: upload.size,
          storedParts: [],
        },
      };
    });
  }

  #upload(id: ItemId): UploadRow | undefined {
    return this.#rows<UploadRow>(
      "SELECT * FROM uploads WHERE id = ? AND closing = 0",
      id,
    )[0];
  }

  partPlan(id: ItemId, partNumber: number): PartPlan {
    if (this.file(id)) return { status: "finished" };
    const row = this.#upload(id);
    if (!row) return { status: "unknown" };
    if (partNumber < 1 || partNumber > partCountFor(row.size)) {
      return { status: "badPartNumber" };
    }
    const stored = this.#rows(
      "SELECT 1 AS found FROM upload_parts WHERE upload_id = ? AND part_number = ?",
      id,
      partNumber,
    );
    if (stored.length > 0) return { status: "stored" };
    return {
      status: "needed",
      size: row.size,
      r2Key: row.r2_key,
      r2UploadId: row.r2_upload_id,
    };
  }

  recordPart(id: ItemId, partNumber: number, etag: string, now: number): void {
    this.#db.transaction(() => {
      if (!this.#upload(id)) return;
      this.#db.exec(
        `INSERT INTO upload_parts (upload_id, part_number, etag) VALUES (?, ?, ?)
         ON CONFLICT (upload_id, part_number) DO UPDATE SET etag = excluded.etag`,
        id,
        partNumber,
        etag,
      );
      this.#db.exec("UPDATE uploads SET touched_at = ? WHERE id = ?", now, id);
    });
  }

  completionPlan(id: ItemId): CompletionPlan {
    const finished = this.file(id);
    if (finished) return { status: "finished", item: finished };
    const row = this.#upload(id);
    if (!row) return { status: "unknown" };
    return {
      status: "ready",
      size: row.size,
      r2Key: row.r2_key,
      r2UploadId: row.r2_upload_id,
      parts: this.#rows<{ part_number: number; etag: string }>(
        "SELECT part_number, etag FROM upload_parts WHERE upload_id = ? ORDER BY part_number",
        id,
      ).map((part) => ({ partNumber: part.part_number, etag: part.etag })),
    };
  }

  // The item takes the upload's id, so a repeat finds it and changes nothing. A taken
  // name is decided here, inside the transaction that claims the new one.
  commitUpload(id: ItemId, driveId: DriveId, now: number): CommitResult {
    return this.#db.transaction((): CommitResult => {
      const finished = this.file(id);
      if (finished) return { status: "committed", item: finished };
      const row = this.#upload(id);
      if (!row) return { status: "unknown" };
      const parentId = row.parent_id as ItemId | null;

      let name = row.name;
      for (
        let number = 2;
        !this.#nameIsFree(parentId, nameKeyOf(name));
        number += 1
      ) {
        name = numberedName(row.name, number);
      }
      this.#db.exec(
        `INSERT INTO items (id, parent_id, kind, name, name_key, size, mime_type, r2_key, created_by, created_at, changed_at)
         VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        parentId,
        name,
        nameKeyOf(name),
        row.size,
        row.mime_type,
        row.r2_key,
        row.created_by,
        now,
        now,
      );
      this.removeUpload(id);
      this.#touchChain(parentId, now);
      this.#noteChange(driveId, row.size, 1, now);
      return { status: "committed", item: this.file(id) as FileItem };
    });
  }

  removeUpload(id: string): void {
    this.#db.exec("DELETE FROM upload_parts WHERE upload_id = ?", id);
    this.#db.exec("DELETE FROM uploads WHERE id = ?", id);
  }

  r2KeyOf(id: ItemId): string | null {
    const [row] = this.#rows<{ r2_key: string | null }>(
      "SELECT r2_key FROM items WHERE id = ?",
      id,
    );
    return row?.r2_key ?? null;
  }

  // R2 calls let other requests run in between, so a stale upload is closed before any
  // of them. Once closed, nothing can finish it, and removing its object is safe.
  closeStaleUploads(now: number, limit: number): StaleUpload[] {
    const stale = this.#rows<UploadRow>(
      "SELECT * FROM uploads WHERE touched_at <= ? ORDER BY touched_at LIMIT ?",
      now - UPLOAD_EXPIRY_MS,
      limit,
    );
    for (const row of stale) {
      this.#db.exec("UPDATE uploads SET closing = 1 WHERE id = ?", row.id);
    }
    return stale.map((row) => ({
      id: row.id,
      r2Key: row.r2_key,
      r2UploadId: row.r2_upload_id,
    }));
  }

  // Comes back round after `retryAt`, so a failure can't spin the alarm.
  postponeUpload(id: string, retryAt: number): void {
    this.#db.exec(
      "UPDATE uploads SET touched_at = ? WHERE id = ?",
      retryAt - UPLOAD_EXPIRY_MS,
      id,
    );
  }

  nextUploadExpiryAt(): number | null {
    const [row] = this.#rows<{ touched_at: number }>(
      "SELECT touched_at FROM uploads ORDER BY touched_at LIMIT 1",
    );
    return row ? row.touched_at + UPLOAD_EXPIRY_MS : null;
  }

  usage(): Usage | null {
    const [row] = this.#rows<{
      drive_id: string;
      used_bytes: number;
      file_count: number;
      changed_at: number;
    }>("SELECT * FROM drive_state");
    return row
      ? {
          driveId: row.drive_id as DriveId,
          usedBytes: row.used_bytes,
          fileCount: row.file_count,
          changedAt: row.changed_at,
        }
      : null;
  }

  usageWriteDueAt(): number | null {
    const [row] = this.#rows<{ sync_due_at: number | null }>(
      "SELECT sync_due_at FROM drive_state",
    );
    return row?.sync_due_at ?? null;
  }

  // A change made while the write was on its way keeps the flag, because D1 doesn't
  // hold it yet.
  markUsageWritten(written: Usage): void {
    this.#db.exec(
      `UPDATE drive_state SET sync_due_at = NULL
       WHERE used_bytes = ? AND file_count = ? AND changed_at = ?`,
      written.usedBytes,
      written.fileCount,
      written.changedAt,
    );
  }

  postponeUsageWrite(retryAt: number): void {
    this.#db.exec("UPDATE drive_state SET sync_due_at = ?", retryAt);
  }
}
