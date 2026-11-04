import {
  type AccessLevel,
  type DriveId,
  type DriveRole,
  levelOfRole,
  type UserId,
} from "@cloudysuite/access";
import type { SqlDriver, SqlRow, SqlValue } from "@cloudysuite/object-sql";
import { partCountFor } from "@cloudysuite/transfer";
import {
  type IncomingPhase,
  type MoveDelivery,
  type MovedRow,
  movedBytes,
  type OutgoingMove,
  type OutgoingPhase,
  type ReceiveResult,
} from "./moves";
import { nameKeyOf, numberedName, type ParsedName } from "./names";
import type {
  DriveItem,
  FileItem,
  CloseResult,
  FolderItem,
  FolderListing,
  ItemId,
  ItemShare,
  ItemShares,
  MoveNotice,
  MoveResult,
  MoveSetback,
  NewFolderResult,
  NoAccess,
  OpenedItem,
  RenameResult,
  RestoreResult,
  SharedLine,
  ShareResult,
  TrashEntry,
  TrashResult,
  UploadView,
} from "./types";
import { MAX_ITEMS_ACROSS_DRIVES, TRASH_MS } from "./types";

export const UPLOAD_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;
export const USAGE_RETRY_MS = 60_000;
export const SHARE_INDEX_RETRY_MS = 60_000;
export const NOTICE_INDEX_RETRY_MS = 60_000;
const PAGE_SIZE = 200;
// Long enough for any late copy of a delivery to have arrived or died.
const SETTLED_MOVE_MS = 7 * 24 * 60 * 60 * 1000;

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
  move_id: string | null;
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
  (SELECT count(*) FROM items AS child WHERE coalesce(child.parent_id, '') = items.id AND child.trash_id IS NULL) AS contains
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

// An item and everything inside it. Items deleted earlier have a null parent, so a
// folder's tree holds only what is still in it.
const TREE = `WITH RECURSIVE tree(id, depth) AS (
  SELECT id, 0 FROM items WHERE id = ?
  UNION ALL
  SELECT items.id, tree.depth + 1
  FROM items JOIN tree ON items.parent_id = tree.id
)`;

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

// Who is asking. It comes from checkDriveAccess on the request that's asking, so taking
// someone off a drive counts from their next request. Role is null for someone not on
// the drive's list.
export type Actor = { userId: UserId; role: DriveRole | null };

// topId is the outermost shared folder or file at or above the item, and null when the
// person can see the whole drive.
export type Reach = { level: AccessLevel; topId: ItemId | null };

export type StoredFile = { file: FileItem; r2Key: string };

export type ShareIndexWrite = {
  itemId: string;
  userId: string;
  revision: number;
  present: boolean;
};

export type NoticeIndexWrite = {
  moveId: string;
  userId: string;
  present: boolean;
};

type ShareRow = SqlRow & {
  item_id: string;
  kind: "person" | "organisation";
  user_id: string | null;
  level: AccessLevel;
  shared_by: string;
  shared_at: number;
};

function parseShare(row: ShareRow): ItemShare {
  const fields = {
    sharedBy: row.shared_by as UserId,
    sharedAt: row.shared_at,
  };
  switch (row.kind) {
    case "person":
      return {
        ...fields,
        kind: "person",
        userId: row.user_id as UserId,
        level: row.level,
      };
    case "organisation":
      return { ...fields, kind: "organisation", level: "view" };
  }
}

const NO_ACCESS: NoAccess = { status: "noAccess" };

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
  | NoAccess
  | { status: "finished" }
  | { status: "unknown" }
  | { status: "folderGone" }
  | { status: "badPartNumber" }
  | { status: "stored" }
  | {
      status: "needed";
      size: number;
      r2Key: string;
      r2UploadId: string;
    };

export type CompletionPlan =
  | NoAccess
  | { status: "finished"; item: FileItem }
  | { status: "unknown" }
  | { status: "folderGone" }
  | {
      status: "ready";
      size: number;
      r2Key: string;
      r2UploadId: string;
      parts: { partNumber: number; etag: string }[];
    };

export type CommitResult =
  | { status: "committed"; item: FileItem }
  | { status: "unknown" }
  | { status: "folderGone" }
  | { status: "folderBusy" }
  | { status: "overLimit" }
  | NoAccess;

export type NewUploadResult =
  { status: "created" | "lost"; upload: UploadView } | { status: "folderGone" };

type FolderState = "open" | "locked" | "gone";

export type StaleUpload = { id: string; r2Key: string; r2UploadId: string };

export class DriveStore {
  readonly #db: SqlDriver;

  constructor(db: SqlDriver) {
    this.#db = db;
  }

  #rows<Row extends SqlRow>(query: string, ...bindings: SqlValue[]): Row[] {
    return this.#db.exec<Row>(query, ...bindings).toArray();
  }

  // The one rule for what a person can do to one item. Being on the drive reaches all of
  // it. Otherwise a share must be on the item or a folder it's in right now, walking up
  // from the item itself, so an id from anywhere else finds nothing, and moving something
  // out of a shared folder ends what it got from that folder. Trash takes a share's reach
  // away without removing the share: a folder in Trash holds no parent, and everything in
  // it carries trash_id.
  reachOf(actor: Actor, id: ItemId | null): Reach | null {
    const onDrive = actor.role ? levelOfRole(actor.role) : null;
    if (id === null) return onDrive ? { level: onDrive, topId: null } : null;
    const chain = this.#rows<{
      id: string;
      trash_id: string | null;
      share_level: AccessLevel | null;
    }>(
      `${CHAIN}
       SELECT chain.id, items.trash_id, shares.level AS share_level
       FROM chain JOIN items ON items.id = chain.id
       LEFT JOIN shares ON shares.item_id = chain.id
         AND (shares.kind = 'organisation' OR shares.user_id = ?)
       ORDER BY chain.depth`,
      id,
      actor.userId,
    );
    const inPlace = chain.length > 0 && chain.every((row) => !row.trash_id);
    const matches = inPlace
      ? chain.filter((row) => row.share_level !== null)
      : [];
    const edits =
      onDrive === "edit" || matches.some((row) => row.share_level === "edit");
    if (!onDrive && matches.length === 0) return null;
    return {
      level: edits ? "edit" : "view",
      topId: onDrive ? null : (matches.at(-1)?.id as ItemId),
    };
  }

  #canEdit(actor: Actor, id: ItemId | null): boolean {
    return this.reachOf(actor, id)?.level === "edit";
  }

  // Being on the drive is the only way to reach its Trash as a whole.
  #canEditDrive(actor: Actor): boolean {
    return actor.role !== null && levelOfRole(actor.role) === "edit";
  }

  #trimmed<Item extends DriveItem>(item: Item, reach: Reach): Item {
    return item.id === reach.topId ? { ...item, parentId: null } : item;
  }

  opened(actor: Actor, id: ItemId): OpenedItem | null {
    const reach = this.reachOf(actor, id);
    const item = reach && this.item(id);
    return reach && item
      ? {
          item: this.#trimmed(item, reach),
          canEdit: reach.level === "edit",
          shared: reach.topId !== null,
        }
      : null;
  }

  // Trashed items don't exist for anything a person reads.
  item(id: ItemId): DriveItem | null {
    const [row] = this.#rows<ItemRow>(
      `${SELECT_ITEMS} WHERE items.id = ? AND items.trash_id IS NULL`,
      id,
    );
    return row ? parseItem(row) : null;
  }

  // An upload that became a file stays finished, wherever that file is now.
  #finishedFile(id: ItemId): FileItem | null {
    const [row] = this.#rows<ItemRow>(
      `${SELECT_ITEMS} WHERE items.id = ? AND items.kind = 'file'`,
      id,
    );
    return row ? (parseItem(row) as FileItem) : null;
  }

  #folder(id: ItemId): FolderItem | null {
    const item = this.item(id);
    return item?.kind === "folder" ? item : null;
  }

  file(id: ItemId): FileItem | null {
    const item = this.item(id);
    return item?.kind === "file" ? item : null;
  }

  #isClosed(): boolean {
    return (
      this.#rows("SELECT 1 AS found FROM drive_state WHERE closed = 1").length >
      0
    );
  }

  // Whether this person may add something here. A folder that's gone is answered later,
  // the same as for anything else the person can edit.
  mayAddTo(actor: Actor, parentId: ItemId | null): boolean {
    return !this.#isClosed() && this.#canEdit(actor, parentId);
  }

  #folderState(id: ItemId): FolderState {
    const [row] = this.#rows<{ move_id: string | null }>(
      "SELECT move_id FROM items WHERE id = ? AND kind = 'folder' AND trash_id IS NULL",
      id,
    );
    if (!row) return "gone";
    return row.move_id === null ? "open" : "locked";
  }

  // Null when the folder doesn't exist, so a bad link can't look like an empty folder.
  list(
    actor: Actor,
    parentId: ItemId | null,
    cursor: string | null,
  ): FolderListing | null {
    const reach = this.reachOf(actor, parentId);
    if (!reach) return null;
    const found = parentId === null ? null : this.#folder(parentId);
    if (parentId !== null && found === null) return null;
    const folder = found && this.#trimmed(found, reach);

    const after = cursor ? decodeCursor(cursor) : null;
    const rows = this.#rows<ItemRow>(
      `${SELECT_ITEMS}
       WHERE coalesce(items.parent_id, '') = ? AND items.trash_id IS NULL
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
      shared: reach.topId !== null,
      canEdit: reach.level === "edit",
      editableIds:
        reach.level === "edit"
          ? []
          : this.#rows<{ id: string }>(
              `SELECT items.id FROM items JOIN shares ON shares.item_id = items.id
               WHERE coalesce(items.parent_id, '') = ? AND items.trash_id IS NULL
                 AND shares.user_id = ? AND shares.level = 'edit'`,
              parentId ?? "",
              actor.userId,
            ).map((row) => row.id as ItemId),
      folder,
      ancestors: parentId === null ? [] : this.ancestors(parentId, reach.topId),
      contains: folder
        ? folder.contains
        : (this.#rows<{ total: number }>(
            "SELECT count(*) AS total FROM items WHERE coalesce(parent_id, '') = '' AND trash_id IS NULL",
          )[0]?.total ?? 0),
      items: page.map(parseItem),
      nextCursor:
        rows.length > PAGE_SIZE && last
          ? encodeCursor(last.kind, nameKeyOf(last.name))
          : null,
    };
  }

  moveNotices(actor: Actor): MoveNotice[] {
    return this.#rows<{
      move_id: string;
      item_id: string;
      name: string;
      setback: MoveSetback["status"];
      bytes: number | null;
      noted_at: number;
    }>(
      `SELECT move_id, item_id, name, setback, bytes, noted_at FROM move_notices
       WHERE user_id = ? AND dismissed = 0 ORDER BY noted_at DESC`,
      actor.userId,
    ).map((row) => ({
      moveId: row.move_id,
      name: this.reachOf(actor, row.item_id as ItemId) ? row.name : null,
      setback:
        row.setback === "overLimit"
          ? { status: row.setback, bytes: row.bytes as number }
          : { status: row.setback },
      notedAt: row.noted_at,
    }));
  }

  // Only the person it's for can dismiss it, and doing it twice changes nothing.
  dismissMoveNotice(actor: Actor, moveId: string, now: number): void {
    this.#db.exec(
      `UPDATE move_notices SET dismissed = 1, index_due_at = ?
       WHERE move_id = ? AND user_id = ? AND dismissed = 0`,
      now + NOTICE_INDEX_RETRY_MS,
      moveId,
      actor.userId,
    );
  }

  noticeIndexWrites(limit: number): NoticeIndexWrite[] {
    return this.#rows<{ move_id: string; user_id: string; dismissed: number }>(
      `SELECT move_id, user_id, dismissed FROM move_notices
       WHERE index_due_at IS NOT NULL ORDER BY index_due_at LIMIT ?`,
      limit,
    ).map((row) => ({
      moveId: row.move_id,
      userId: row.user_id,
      present: row.dismissed === 0,
    }));
  }

  // A dismissal made while the write was on its way no longer matches, so it stays queued.
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

  nextNoticeIndexWriteAt(): number | null {
    return (
      this.#rows<{ next: number | null }>(
        "SELECT min(index_due_at) AS next FROM move_notices",
      )[0]?.next ?? null
    );
  }

  // Names above topId stay out of it, because the person can't reach those folders.
  ancestors(id: ItemId, topId: ItemId | null): FolderItem[] {
    const all = this.#rows<ItemRow>(
      `${CHAIN}
       SELECT items.*, 0 AS contains FROM items JOIN chain ON items.id = chain.id
       WHERE chain.depth > 0 ORDER BY chain.depth DESC`,
      id,
    ).map(parseItem) as FolderItem[];
    if (topId === null) return all;
    const top = all.findIndex((folder) => folder.id === topId);
    if (top === -1) return [];
    return all
      .slice(top)
      .map((folder) =>
        folder.id === topId ? { ...folder, parentId: null } : folder,
      );
  }

  // Recent is what's in the drives a person is on. It doesn't reach into shares.
  recent(actor: Actor, limit: number): FileItem[] {
    if (actor.role === null) return [];
    return this.#rows<ItemRow>(
      `SELECT items.*, 0 AS contains FROM items WHERE kind = 'file' AND trash_id IS NULL
       ORDER BY changed_at DESC, id LIMIT ?`,
      limit,
    ).map(parseItem) as FileItem[];
  }

  #nameIsFree(parentId: ItemId | null, nameKey: string): boolean {
    return (
      this.#rows(
        "SELECT 1 AS found FROM items WHERE coalesce(parent_id, '') = ? AND name_key = ? AND trash_id IS NULL",
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
    actor: Actor;
    driveId: DriveId;
    id: ItemId;
    parentId: ItemId | null;
    name: Extract<ParsedName, { ok: true }>;
    now: number;
  }): NewFolderResult {
    const { actor, driveId, id, parentId, name, now } = input;
    return this.#db.transaction((): NewFolderResult => {
      if (!this.mayAddTo(actor, parentId)) return NO_ACCESS;
      const parent = parentId === null ? "open" : this.#folderState(parentId);
      if (parent === "gone") return { status: "noParent" };
      if (parent === "locked") return { status: "folderBusy" };
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
        actor.userId,
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

  // Someone on the drive can carry on any upload to it. Through a share, only their own,
  // and only while they can still edit where it's going. The finished case matters as much:
  // a file's id is also its upload's, so this mustn't describe a file out of reach.
  mayContinueUpload(actor: Actor, id: ItemId): boolean {
    if (this.#canEditDrive(actor)) return true;
    const upload = this.#upload(id);
    if (upload) {
      return (
        upload.created_by === actor.userId &&
        this.#canEdit(actor, upload.parent_id as ItemId | null)
      );
    }
    // Whoever started an upload hears why it ended, even with no reach left to the folder.
    const closed = this.#rows(
      "SELECT 1 AS found FROM uploads WHERE id = ? AND closing = 1 AND created_by = ?",
      id,
      actor.userId,
    );
    return closed.length > 0 || this.#canEdit(actor, id);
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
  createUpload(upload: NewUpload, now: number): NewUploadResult {
    return this.#db.transaction((): NewUploadResult => {
      if (
        upload.parentId !== null &&
        this.#rows("SELECT 1 AS found FROM items WHERE id = ?", upload.parentId)
          .length === 0
      ) {
        return { status: "folderGone" };
      }
      const existing = this.findUpload(upload, now);
      if (existing) return { status: "lost", upload: existing };
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
        status: "created",
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

  #uploadLostItsFolder(id: ItemId): boolean {
    return (
      this.#rows(
        "SELECT 1 AS found FROM uploads WHERE id = ? AND folder_gone = 1",
        id,
      ).length > 0
    );
  }

  partPlan(actor: Actor, id: ItemId, partNumber: number): PartPlan {
    if (!this.mayContinueUpload(actor, id)) return NO_ACCESS;
    if (this.#finishedFile(id)) return { status: "finished" };
    const row = this.#upload(id);
    if (!row) {
      return {
        status: this.#uploadLostItsFolder(id) ? "folderGone" : "unknown",
      };
    }
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

  recordPart(
    actor: Actor,
    id: ItemId,
    partNumber: number,
    etag: string,
    now: number,
  ): void {
    this.#db.transaction(() => {
      if (!this.#upload(id) || !this.mayContinueUpload(actor, id)) return;
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

  completionPlan(actor: Actor, id: ItemId): CompletionPlan {
    if (!this.mayContinueUpload(actor, id)) return NO_ACCESS;
    const finished = this.#finishedFile(id);
    if (finished) return { status: "finished", item: finished };
    const row = this.#upload(id);
    if (!row) {
      return {
        status: this.#uploadLostItsFolder(id) ? "folderGone" : "unknown",
      };
    }
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
  commitUpload(
    actor: Actor,
    id: ItemId,
    driveId: DriveId,
    now: number,
  ): CommitResult {
    return this.#db.transaction((): CommitResult => {
      if (!this.mayContinueUpload(actor, id)) return NO_ACCESS;
      const finished = this.#finishedFile(id);
      if (finished) return { status: "committed", item: finished };
      const row = this.#upload(id);
      if (!row) {
        return {
          status: this.#uploadLostItsFolder(id) ? "folderGone" : "unknown",
        };
      }
      // A folder in Trash can't take the file, which is still wanted, so it lands at the
      // drive's root rather than vanishing with the folder. A locked folder may be back
      // in a moment, or gone to another drive, so the sender asks again.
      const wanted = row.parent_id as ItemId | null;
      const folder = wanted === null ? "gone" : this.#folderState(wanted);
      if (folder === "locked") return { status: "folderBusy" };
      const parentId = folder === "open" ? wanted : null;

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

  uploadFolderIsLocked(id: ItemId): boolean {
    const parentId = this.#upload(id)?.parent_id as ItemId | null | undefined;
    return parentId ? this.#folderState(parentId) === "locked" : false;
  }

  // Null when there's nothing left to commit: it finished already, or it's gone.
  uncommittedSize(id: ItemId): number | null {
    return this.file(id) ? null : (this.#upload(id)?.size ?? null);
  }

  // Dated as already expired, so the sweep that removes stopped uploads takes it next.
  closeRefusedUpload(id: ItemId, now: number): void {
    this.#db.exec(
      "UPDATE uploads SET closing = 1, touched_at = ? WHERE id = ?",
      now - UPLOAD_EXPIRY_MS,
      id,
    );
  }

  forgetUpload(actor: Actor, id: ItemId): void {
    // A closed upload is the sweep's to remove, because it still has R2 data to clear.
    if (this.#upload(id) && this.mayContinueUpload(actor, id)) {
      this.removeUpload(id);
    }
  }

  removeUpload(id: string): void {
    this.#db.exec("DELETE FROM upload_parts WHERE upload_id = ?", id);
    this.#db.exec("DELETE FROM uploads WHERE id = ?", id);
  }

  storedFile(actor: Actor, id: ItemId): StoredFile | null {
    const file = this.opened(actor, id)?.item;
    if (file?.kind !== "file") return null;
    const [row] = this.#rows<{ r2_key: string }>(
      "SELECT r2_key FROM items WHERE id = ?",
      id,
    );
    return row ? { file, r2Key: row.r2_key } : null;
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

  // Taken names are refused rather than numbered, because the person is choosing this
  // name and can choose another. Only the name's own case can change onto itself.
  rename(input: {
    actor: Actor;
    driveId: DriveId;
    id: ItemId;
    name: Extract<ParsedName, { ok: true }>;
    now: number;
  }): RenameResult {
    const { actor, driveId, id, name, now } = input;
    return this.#db.transaction((): RenameResult => {
      if (!this.#canEdit(actor, id)) return NO_ACCESS;
      const item = this.item(id);
      if (!item) return { status: "gone" };
      if (this.#isLocked(id)) return { status: "busy" };
      if (
        nameKeyOf(item.name) !== name.nameKey &&
        !this.#nameIsFree(item.parentId, name.nameKey)
      ) {
        return { status: "nameTaken" };
      }
      if (item.name === name.name) return { status: "renamed", item };
      this.#db.exec(
        "UPDATE items SET name = ?, name_key = ?, changed_at = ? WHERE id = ?",
        name.name,
        name.nameKey,
        now,
        id,
      );
      this.#touchChain(item.parentId, now);
      this.#noteChange(driveId, 0, 0, now);
      return { status: "renamed", item: this.item(id) as DriveItem };
    });
  }

  #isLocked(id: ItemId): boolean {
    return (
      this.#rows(
        "SELECT 1 AS found FROM items WHERE id = ? AND move_id IS NOT NULL",
        id,
      ).length > 0
    );
  }

  #treeIsLocked(id: ItemId): boolean {
    return (
      this.#rows(
        `${TREE} SELECT 1 AS found FROM items JOIN tree ON items.id = tree.id
         WHERE items.move_id IS NOT NULL LIMIT 1`,
        id,
      ).length > 0
    );
  }

  moveWithin(input: {
    actor: Actor;
    driveId: DriveId;
    id: ItemId;
    toParentId: ItemId | null;
    now: number;
  }): MoveResult {
    const { actor, driveId, id, toParentId, now } = input;
    return this.#db.transaction((): MoveResult => {
      if (!this.#canEdit(actor, id) || !this.#canEdit(actor, toParentId)) {
        return NO_ACCESS;
      }
      const item = this.item(id);
      if (!item) return { status: "gone" };
      if (this.#isLocked(id)) return { status: "busy" };
      if (toParentId !== null) {
        const inside = this.#rows(
          `${CHAIN} SELECT 1 AS found FROM chain WHERE id = ? LIMIT 1`,
          toParentId,
          id,
        );
        if (inside.length > 0) return { status: "intoItself" };
        const destination = this.#folderState(toParentId);
        if (destination === "gone") return { status: "noDestination" };
        if (destination === "locked") return { status: "folderBusy" };
      }
      if (item.parentId === toParentId) return { status: "moved" };
      if (!this.#nameIsFree(toParentId, nameKeyOf(item.name))) {
        return { status: "nameTaken" };
      }
      this.#db.exec(
        "UPDATE items SET parent_id = ? WHERE id = ?",
        toParentId,
        id,
      );
      this.#touchChain(item.parentId, now);
      this.#touchChain(toParentId, now);
      this.#noteChange(driveId, 0, 0, now);
      return { status: "moved" };
    });
  }

  beginMoveOut(input: {
    actor: Actor;
    moveId: string;
    id: ItemId;
    fromDriveId: DriveId;
    toDriveId: DriveId;
    toParentId: ItemId | null;
    tryAt: number;
    giveUpAt: number;
  }): MoveResult | { status: "begun" } {
    const {
      actor,
      moveId,
      id,
      fromDriveId,
      toDriveId,
      toParentId,
      tryAt,
      giveUpAt,
    } = input;
    return this.#db.transaction(() => {
      if (!this.#canEdit(actor, id)) return NO_ACCESS;
      if (!this.item(id)) return { status: "gone" as const };
      if (this.#treeIsLocked(id)) return { status: "busy" as const };
      const [count] = this.#rows<{ total: number }>(
        `${TREE} SELECT count(*) AS total FROM tree`,
        id,
      );
      if ((count?.total ?? 0) > MAX_ITEMS_ACROSS_DRIVES) {
        return { status: "tooMany" as const };
      }
      this.#db.exec(
        `${TREE} UPDATE items SET move_id = ? WHERE id IN (SELECT id FROM tree)`,
        id,
        moveId,
      );
      this.#db.exec(
        `INSERT INTO moves_out (id, top_id, from_drive_id, to_drive_id, to_parent_id, try_at, give_up_at, moved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        moveId,
        id,
        fromDriveId,
        toDriveId,
        toParentId,
        tryAt,
        giveUpAt,
        actor.userId,
      );
      return { status: "begun" as const };
    });
  }

  outgoingMove(moveId: string): OutgoingMove | null {
    const [move] = this.#rows<{
      phase: OutgoingPhase;
      top_id: string;
      from_drive_id: string;
      to_drive_id: string;
      to_parent_id: string | null;
      give_up_at: number;
    }>("SELECT * FROM moves_out WHERE id = ?", moveId);
    if (!move) return null;
    const toDriveId = move.to_drive_id as DriveId;
    if (move.phase !== "sending") {
      return { phase: move.phase, moveId, toDriveId };
    }
    const toParentId = move.to_parent_id as ItemId | null;
    const rows = this.#rows<
      ItemRow & { name_key: string; r2_key: string | null }
    >(
      `${TREE} SELECT items.* FROM items JOIN tree ON items.id = tree.id ORDER BY tree.depth`,
      move.top_id,
    ).map((row, index): MovedRow => ({
      id: row.id,
      parentId: index === 0 ? toParentId : row.parent_id,
      kind: row.kind,
      name: row.name,
      nameKey: row.name_key,
      size: row.size,
      mimeType: row.mime_type,
      r2Key: row.r2_key,
      createdBy: row.created_by,
      createdAt: row.created_at,
      changedAt: row.changed_at,
    }));
    return {
      phase: "sending",
      giveUpAt: move.give_up_at,
      moveId,
      fromDriveId: move.from_drive_id as DriveId,
      toDriveId,
      toParentId,
      rows,
    };
  }

  #incomingPhase(moveId: string): IncomingPhase | null {
    return (
      this.#rows<{ phase: IncomingPhase }>(
        "SELECT phase FROM moves_in WHERE id = ?",
        moveId,
      )[0]?.phase ?? null
    );
  }

  // Null means the rows can be added.
  receiveAnswer(move: MoveDelivery): ReceiveResult | null {
    const phase = this.#incomingPhase(move.moveId);
    if (phase === "abandoned") return { status: "noDestination" };
    if (phase !== null) return { status: "received" };
    if (this.#isClosed()) return { status: "noDestination" };
    if (move.toParentId !== null) {
      const destination = this.#folderState(move.toParentId);
      if (destination === "gone") return { status: "noDestination" };
      if (destination === "locked") return { status: "folderBusy" };
    }
    const top = move.rows[0];
    return top && !this.#nameIsFree(move.toParentId, top.nameKey)
      ? { status: "nameTaken" }
      : null;
  }

  receiveMove(move: MoveDelivery, now: number): ReceiveResult {
    return this.#db.transaction((): ReceiveResult => {
      const answer = this.receiveAnswer(move);
      if (answer) return answer;
      for (const row of move.rows) {
        this.#db.exec(
          `INSERT INTO items (id, parent_id, kind, name, name_key, size, mime_type, r2_key, created_by, created_at, changed_at, move_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id,
          row.parentId,
          row.kind,
          row.name,
          row.nameKey,
          row.size,
          row.mimeType,
          row.r2Key,
          row.createdBy,
          row.createdAt,
          row.changedAt,
          move.moveId,
        );
      }
      this.#db.exec("INSERT INTO moves_in (id) VALUES (?)", move.moveId);
      this.#touchChain(move.toParentId, now);
      this.#noteChange(
        move.toDriveId,
        movedBytes(move.rows),
        move.rows.filter((row) => row.kind === "file").length,
        now,
      );
      return { status: "received" };
    });
  }

  #settleMoveIn(moveId: string, phase: IncomingPhase, now: number): void {
    this.#db.exec(
      `INSERT INTO moves_in (id, phase, settled_at) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET phase = excluded.phase, settled_at = excluded.settled_at`,
      moveId,
      phase,
      now,
    );
    this.#db.exec(
      "DELETE FROM moves_in WHERE settled_at <= ?",
      now - SETTLED_MOVE_MS,
    );
  }

  // The sender has removed its rows, so these are now the only owner of the bytes.
  confirmMoveIn(moveId: string, now: number): void {
    this.#db.transaction(() => {
      if (this.#incomingPhase(moveId) !== "locked") return;
      this.#db.exec(
        "UPDATE items SET move_id = NULL WHERE move_id = ?",
        moveId,
      );
      this.#settleMoveIn(moveId, "unlocked", now);
    });
  }

  // The sender kept the bytes, so these rows leave and queue no R2 deletion. A move this
  // drive never heard of still leaves a record, in case its delivery is on the way.
  abandonMoveIn(moveId: string, driveId: DriveId, now: number): void {
    this.#db.transaction(() => {
      const phase = this.#incomingPhase(moveId);
      if (phase === "unlocked" || phase === "abandoned") return;
      if (phase === "locked") this.#removeLockedRows(moveId, driveId, now);
      this.#settleMoveIn(moveId, "abandoned", now);
    });
  }

  #removeLockedRows(moveId: string, driveId: DriveId, now: number): void {
    // Rows went in parents first and nothing can be added to a locked folder.
    const rows = this.#rows<{
      id: string;
      kind: string;
      size: number | null;
      parent_id: string | null;
    }>(
      "SELECT id, kind, size, parent_id FROM items WHERE move_id = ? ORDER BY rowid DESC",
      moveId,
    );
    let bytes = 0;
    let files = 0;
    for (const row of rows) {
      this.#closeUploadsIn(row.id);
      // Someone who could open it while it was arriving may have starred it.
      this.#dropShares(row.id, now);
      this.#db.exec("DELETE FROM items WHERE id = ?", row.id);
      if (row.kind === "file") {
        bytes += row.size ?? 0;
        files += 1;
      }
    }
    this.#touchChain((rows.at(-1)?.parent_id ?? null) as ItemId | null, now);
    this.#noteChange(driveId, -bytes, -files, now);
  }

  // The other drive holds locked rows now, and the same R2 objects, which stay where they
  // are. Removing a row queues no R2 deletion. The record stays until the other drive has
  // unlocked its rows.
  handOverMove(input: {
    moveId: string;
    driveId: DriveId;
    now: number;
    tryAt: number;
  }): void {
    const { moveId, driveId, now, tryAt } = input;
    this.#db.transaction(() => {
      const [move] = this.#rows<{ top_id: string }>(
        "SELECT top_id FROM moves_out WHERE id = ? AND phase = 'sending'",
        moveId,
      );
      if (!move) return;
      const top = this.#rows<{ parent_id: string | null }>(
        "SELECT parent_id FROM items WHERE id = ?",
        move.top_id,
      )[0];
      const rows = this.#rows<{
        id: string;
        kind: string;
        size: number | null;
      }>(
        `${TREE} SELECT items.id, items.kind, items.size FROM items
         JOIN tree ON items.id = tree.id ORDER BY tree.depth DESC`,
        move.top_id,
      );
      let bytes = 0;
      let files = 0;
      for (const row of rows) {
        this.#closeUploadsIn(row.id);
        this.#dropShares(row.id, now);
        this.#db.exec("DELETE FROM items WHERE id = ?", row.id);
        if (row.kind === "file") {
          bytes += row.size ?? 0;
          files += 1;
        }
      }
      this.#db.exec(
        "UPDATE moves_out SET phase = 'confirming', try_at = ? WHERE id = ?",
        tryAt,
        moveId,
      );
      this.#touchChain((top?.parent_id ?? null) as ItemId | null, now);
      this.#noteChange(driveId, -bytes, -files, now);
    });
  }

  endMoveOut(moveId: string): void {
    this.#db.exec("DELETE FROM moves_out WHERE id = ?", moveId);
  }

  #unlock(moveId: string): void {
    this.#db.exec("UPDATE items SET move_id = NULL WHERE move_id = ?", moveId);
  }

  // Only while the move is sending, so it's written once.
  #noteSetback(moveId: string, setback: MoveSetback, now: number): void {
    this.#db.exec(
      `INSERT INTO move_notices (move_id, user_id, item_id, name, setback, bytes, noted_at, index_due_at)
       SELECT moves_out.id, moves_out.moved_by, items.id, items.name, ?, ?, ?, ?
       FROM moves_out JOIN items ON items.id = moves_out.top_id
       WHERE moves_out.id = ? AND moves_out.phase = 'sending' AND moves_out.moved_by IS NOT NULL`,
      setback.status,
      setback.status === "overLimit" ? setback.bytes : null,
      now,
      now + NOTICE_INDEX_RETRY_MS,
      moveId,
    );
  }

  // The other drive refused, so it holds nothing.
  cancelMoveOut(moveId: string, notice: MoveSetback | null, now: number): void {
    this.#db.transaction(() => {
      if (notice) this.#noteSetback(moveId, notice, now);
      this.#unlock(moveId);
      this.endMoveOut(moveId);
    });
  }

  // The other drive never answered, so it may hold locked rows. Those can't delete
  // anything, so these rows are safe to free now, and the alarm keeps telling it.
  giveUpMoveOut(moveId: string, now: number): void {
    this.#db.transaction(() => {
      this.#noteSetback(moveId, { status: "noAnswer" }, now);
      this.#unlock(moveId);
      this.#db.exec(
        "UPDATE moves_out SET phase = 'abandoning', try_at = ? WHERE id = ? AND phase = 'sending'",
        now,
        moveId,
      );
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

  nextMoveAt(): number | null {
    return (
      this.#rows<{ next: number | null }>(
        "SELECT min(try_at) AS next FROM moves_out",
      )[0]?.next ?? null
    );
  }

  // Bytes stay counted until they're deleted forever. Files leave the file count now,
  // because the count is what people see on a team folder.
  trash(input: {
    actor: Actor;
    driveId: DriveId;
    id: ItemId;
    now: number;
  }): TrashResult {
    const { actor, driveId, id, now } = input;
    return this.#db.transaction((): TrashResult => {
      if (!this.#canEdit(actor, id)) return NO_ACCESS;
      const item = this.item(id);
      if (!item) return { status: "gone" };
      if (this.#treeIsLocked(id)) return { status: "busy" };
      const [files] = this.#rows<{ total: number }>(
        `${TREE} SELECT count(*) AS total FROM items JOIN tree ON items.id = tree.id
         WHERE items.kind = 'file'`,
        id,
      );
      this.#db.exec(
        `${TREE} UPDATE items SET trash_id = ? WHERE id IN (SELECT id FROM tree)`,
        id,
        id,
      );
      this.#db.exec(
        `UPDATE items SET parent_id = NULL, trashed_from = ?, trashed_at = ?, purge_at = ?,
           trashed_by = ?
         WHERE id = ?`,
        item.parentId,
        now,
        now + TRASH_MS,
        actor.userId,
        id,
      );
      this.#touchChain(item.parentId, now);
      this.#noteChange(driveId, 0, -(files?.total ?? 0), now);
      return { status: "trashed" };
    });
  }

  trashEntries(actor: Actor, now: number, limit: number): TrashEntry[] {
    if (!this.#canEditDrive(actor)) return [];
    return this.#rows<
      SqlRow & {
        id: string;
        kind: "folder" | "file";
        name: string;
        mime_type: string | null;
        bytes: number;
        members: number;
        trashed_at: number;
        purge_at: number;
        trashed_from: string | null;
        from_name: string | null;
      }
    >(
      `SELECT items.id, items.kind, items.name, items.mime_type, items.trashed_at,
         items.purge_at, items.trashed_from,
         (SELECT coalesce(sum(unit.size), 0) FROM items AS unit WHERE unit.trash_id = items.id) AS bytes,
         (SELECT count(*) FROM items AS unit WHERE unit.trash_id = items.id) AS members,
         (SELECT origin.name FROM items AS origin
           WHERE origin.id = items.trashed_from AND origin.trash_id IS NULL) AS from_name
       FROM items WHERE items.purge_at > ?
       ORDER BY items.trashed_at DESC, items.id LIMIT ?`,
      now,
      limit,
    ).map((row) => ({
      id: row.id as ItemId,
      kind: row.kind,
      name: row.name,
      mimeType: row.mime_type,
      size: row.bytes,
      contains: row.members - 1,
      trashedAt: row.trashed_at,
      purgeAt: row.purge_at,
      fromFolder: row.trashed_from === null ? null : { name: row.from_name },
    }));
  }

  // A taken name keeps both, because the person didn't choose a name here and refusing
  // would leave the item stuck in Trash.
  restore(input: {
    actor: Actor;
    driveId: DriveId;
    id: ItemId;
    now: number;
  }): RestoreResult {
    const { actor, driveId, id, now } = input;
    return this.#db.transaction((): RestoreResult => {
      const [top] = this.#rows<{
        name: string;
        trashed_from: string | null;
        trashed_by: string | null;
      }>(
        "SELECT name, trashed_from, trashed_by FROM items WHERE id = ? AND purge_at > ?",
        id,
        now,
      );
      const from = (top?.trashed_from ?? null) as ItemId | null;
      if (!this.#canEditDrive(actor)) {
        // Someone reaching it through a share gets Undo for their own delete and nothing
        // else. Trash stays out of their sight.
        const undoable =
          top?.trashed_by === actor.userId &&
          (this.#canEdit(actor, from) || this.#hasEditShare(actor, id));
        if (!undoable) return NO_ACCESS;
      }
      if (!top) return { status: "gone" };
      const folder = from === null ? "open" : this.#folderState(from);
      if (folder === "locked") return { status: "folderBusy" };
      const folderGone = folder === "gone";
      const parentId = folderGone ? null : from;

      let name = top.name;
      for (
        let number = 2;
        !this.#nameIsFree(parentId, nameKeyOf(name));
        number += 1
      ) {
        name = numberedName(top.name, number);
      }
      const [files] = this.#rows<{ total: number }>(
        "SELECT count(*) AS total FROM items WHERE trash_id = ? AND kind = 'file'",
        id,
      );
      this.#db.exec(
        `UPDATE items SET parent_id = ?, name = ?, name_key = ?, trash_id = NULL,
           trashed_from = NULL, trashed_at = NULL, purge_at = NULL, trashed_by = NULL
         WHERE id = ?`,
        parentId,
        name,
        nameKeyOf(name),
        id,
      );
      this.#db.exec("UPDATE items SET trash_id = NULL WHERE trash_id = ?", id);
      this.#touchChain(parentId, now);
      this.#noteChange(driveId, 0, files?.total ?? 0, now);
      return {
        status: "restored",
        item: this.item(id) as DriveItem,
        folderGone,
      };
    });
  }

  #hasEditShare(actor: Actor, id: ItemId): boolean {
    return (
      this.#rows(
        "SELECT 1 AS found FROM shares WHERE item_id = ? AND user_id = ? AND level = 'edit'",
        id,
        actor.userId,
      ).length > 0
    );
  }

  // Only ever matches something already in Trash, and repeating it changes nothing.
  markForPurge(actor: Actor, id: ItemId): boolean {
    if (!this.#canEditDrive(actor)) return false;
    this.#db.exec(
      "UPDATE items SET purge_at = 0 WHERE id = ? AND purge_at IS NOT NULL",
      id,
    );
    return true;
  }

  markAllForPurge(actor: Actor, now: number): boolean {
    if (!this.#canEditDrive(actor)) return false;
    this.#db.exec("UPDATE items SET purge_at = 0 WHERE trashed_at <= ?", now);
    return true;
  }

  nextPurgeAt(): number | null {
    return (
      this.#rows<{ next: number | null }>(
        "SELECT min(purge_at) AS next FROM items WHERE purge_at IS NOT NULL",
      )[0]?.next ?? null
    );
  }

  // One transaction removes some rows and queues their objects, so a crash can't lose
  // track of either, and the next run just carries on with what's left. Only rows with
  // nothing inside go, so the row the person chose goes last and the unit stays due
  // until the end.
  purgeBatch(now: number, limit: number): boolean {
    return this.#db.transaction(() => {
      const [unit] = this.#rows<{ id: string }>(
        `SELECT id FROM items WHERE purge_at IS NOT NULL AND purge_at <= ?
         ORDER BY purge_at LIMIT 1`,
        now,
      );
      const usage = this.usage();
      if (!unit || !usage) return false;
      const rows = this.#rows<{
        id: string;
        size: number | null;
        r2_key: string | null;
      }>(
        `SELECT id, size, r2_key FROM items
         WHERE trash_id = ?
           AND NOT EXISTS (SELECT 1 FROM items AS child WHERE child.parent_id = items.id)
         LIMIT ?`,
        unit.id,
        limit,
      );
      let bytes = 0;
      for (const row of rows) {
        if (row.r2_key !== null) {
          this.#db.exec(
            "INSERT OR IGNORE INTO r2_deletions (r2_key, not_before) VALUES (?, 0)",
            row.r2_key,
          );
          bytes += row.size ?? 0;
        }
        this.#closeUploadsIn(row.id);
        this.#dropShares(row.id, now);
        this.#db.exec("DELETE FROM items WHERE id = ?", row.id);
      }
      this.#noteChange(usage.driveId, -bytes, 0, now);
      return true;
    });
  }

  // These uploads have nowhere to land. The sweep removes what they stored, and sending
  // more tells the person it stopped.
  #closeUploadsIn(folderId: string): void {
    this.#db.exec(
      "UPDATE uploads SET closing = 1, folder_gone = 1, parent_id = NULL WHERE parent_id = ?",
      folderId,
    );
  }

  dueR2Deletions(now: number, limit: number): string[] {
    return this.#rows<{ r2_key: string }>(
      "SELECT r2_key FROM r2_deletions WHERE not_before <= ? LIMIT ?",
      now,
      limit,
    ).map((row) => row.r2_key);
  }

  finishR2Deletions(keys: readonly string[]): void {
    this.#db.transaction(() => {
      for (const key of keys) {
        this.#db.exec("DELETE FROM r2_deletions WHERE r2_key = ?", key);
      }
    });
  }

  postponeR2Deletions(keys: readonly string[], until: number): void {
    this.#db.transaction(() => {
      for (const key of keys) {
        this.#db.exec(
          "UPDATE r2_deletions SET not_before = ? WHERE r2_key = ?",
          until,
          key,
        );
      }
    });
  }

  nextR2DeletionAt(): number | null {
    return (
      this.#rows<{ next: number | null }>(
        "SELECT min(not_before) AS next FROM r2_deletions",
      )[0]?.next ?? null
    );
  }

  // Sharing is for what the person can edit, so a Can view person gets no further than
  // this. Saying it twice changes the level and nothing else. A share never travels with a
  // move, so taking one away lets nothing out of it and needn't wait for a lock.
  #withEditableItem(
    actor: Actor,
    id: ItemId,
    access: "grants" | "removes",
    change: () => void,
  ): ShareResult {
    return this.#db.transaction((): ShareResult => {
      if (!this.#canEdit(actor, id)) return NO_ACCESS;
      if (!this.item(id)) return { status: "gone" };
      if (access === "grants" && this.#treeIsLocked(id)) {
        return { status: "busy" };
      }
      change();
      return { status: "done" };
    });
  }

  sharePeople(input: {
    actor: Actor;
    id: ItemId;
    people: readonly UserId[];
    level: AccessLevel;
    now: number;
  }): ShareResult {
    const { actor, id, people, level, now } = input;
    return this.#withEditableItem(actor, id, "grants", () => {
      for (const userId of people) {
        this.#db.exec(
          `INSERT INTO shares (item_id, kind, user_id, level, shared_by, shared_at)
           VALUES (?, 'person', ?, ?, ?, ?)
           ON CONFLICT (item_id, coalesce(user_id, '')) DO UPDATE SET level = excluded.level`,
          id,
          userId,
          level,
          actor.userId,
          now,
        );
        this.queueIndexWrite(id, userId, now);
      }
    });
  }

  unshare(input: {
    actor: Actor;
    id: ItemId;
    userId: UserId;
    now: number;
  }): ShareResult {
    const { actor, id, userId, now } = input;
    return this.#withEditableItem(actor, id, "removes", () => {
      this.#db.exec(
        "DELETE FROM shares WHERE item_id = ? AND user_id = ?",
        id,
        userId,
      );
      this.queueIndexWrite(id, userId, now);
    });
  }

  setEveryone(input: {
    actor: Actor;
    id: ItemId;
    on: boolean;
    now: number;
  }): ShareResult {
    const { actor, id, on, now } = input;
    return this.#withEditableItem(actor, id, on ? "grants" : "removes", () => {
      if (on) {
        this.#db.exec(
          `INSERT INTO shares (item_id, kind, user_id, level, shared_by, shared_at)
           VALUES (?, 'organisation', NULL, 'view', ?, ?)
           ON CONFLICT (item_id, coalesce(user_id, '')) DO NOTHING`,
          id,
          actor.userId,
          now,
        );
      } else {
        this.#db.exec(
          "DELETE FROM shares WHERE item_id = ? AND kind = 'organisation'",
          id,
        );
      }
    });
  }

  sharesOn(actor: Actor, id: ItemId): ItemShares | null {
    const reach = this.reachOf(actor, id);
    if (!reach || !this.item(id)) return null;
    const rows = this.#rows<ShareRow & { depth: number }>(
      `${CHAIN}
       SELECT shares.*, chain.depth FROM shares JOIN chain ON shares.item_id = chain.id
       ORDER BY chain.depth, shares.shared_at`,
      id,
    );
    return {
      here: rows.filter((row) => row.depth === 0).map(parseShare),
      above: rows.filter((row) => row.depth > 0).map(parseShare),
      canEdit: reach.level === "edit",
    };
  }

  // Only what was shared with this person directly. A share on a folder comes back as the
  // folder, and a trashed item stays out until it's restored.
  sharedWith(actor: Actor, limit: number): SharedLine[] {
    return this.#rows<
      ItemRow & {
        share_level: AccessLevel;
        shared_by: string;
        shared_at: number;
      }
    >(
      `SELECT items.*, shares.level AS share_level, shares.shared_by, shares.shared_at,
         (SELECT count(*) FROM items AS child WHERE coalesce(child.parent_id, '') = items.id AND child.trash_id IS NULL) AS contains
       FROM items JOIN shares ON shares.item_id = items.id
       WHERE shares.user_id = ? AND items.trash_id IS NULL
       ORDER BY shares.shared_at DESC, items.id LIMIT ?`,
      actor.userId,
      limit,
    ).flatMap((row) => {
      const reach = this.reachOf(actor, row.id as ItemId);
      return reach
        ? [
            {
              item: { ...parseItem(row), parentId: null },
              level: row.share_level,
              canEdit: reach.level === "edit",
              sharedBy: row.shared_by as UserId,
              sharedAt: row.shared_at,
            },
          ]
        : [];
    });
  }

  queueIndexWrite(itemId: string, userId: string, now: number): void {
    this.#db.exec(
      `INSERT INTO share_index_writes (item_id, user_id, revision, try_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT (item_id, user_id) DO UPDATE SET
         revision = revision + 1, try_at = excluded.try_at`,
      itemId,
      userId,
      now + SHARE_INDEX_RETRY_MS,
    );
  }

  #dropShares(itemId: string, now: number): void {
    for (const { user_id: userId } of this.#rows<{ user_id: string }>(
      `SELECT user_id FROM shares WHERE item_id = ? AND user_id IS NOT NULL
       UNION SELECT user_id FROM stars WHERE item_id = ?`,
      itemId,
      itemId,
    )) {
      this.queueIndexWrite(itemId, userId, now);
    }
    this.#db.exec("DELETE FROM shares WHERE item_id = ?", itemId);
    this.#db.exec("DELETE FROM stars WHERE item_id = ?", itemId);
  }

  shareIndexWrites(limit: number): ShareIndexWrite[] {
    return this.#rows<{
      item_id: string;
      user_id: string;
      revision: number;
      present: number;
    }>(
      `SELECT writes.item_id, writes.user_id, writes.revision,
         (EXISTS (SELECT 1 FROM shares
            WHERE shares.item_id = writes.item_id AND shares.user_id = writes.user_id)
          OR EXISTS (SELECT 1 FROM stars
            WHERE stars.item_id = writes.item_id AND stars.user_id = writes.user_id)) AS present
       FROM share_index_writes AS writes ORDER BY writes.try_at LIMIT ?`,
      limit,
    ).map((row) => ({
      itemId: row.item_id,
      userId: row.user_id,
      revision: row.revision,
      present: row.present === 1,
    }));
  }

  // A change made while the write was on its way has a new revision, so it stays queued.
  finishShareIndexWrites(written: readonly ShareIndexWrite[]): void {
    this.#db.transaction(() => {
      for (const write of written) {
        this.#db.exec(
          "DELETE FROM share_index_writes WHERE item_id = ? AND user_id = ? AND revision = ?",
          write.itemId,
          write.userId,
          write.revision,
        );
      }
    });
  }

  postponeShareIndexWrites(retryAt: number): void {
    this.#db.exec("UPDATE share_index_writes SET try_at = ?", retryAt);
  }

  nextShareIndexWriteAt(): number | null {
    return (
      this.#rows<{ next: number | null }>(
        "SELECT min(try_at) AS next FROM share_index_writes",
      )[0]?.next ?? null
    );
  }

  // Trash and uploads count. Nothing can land after this, so what was found empty stays
  // empty until the drive's D1 row is gone. Repeating it finds the same answer.
  close(driveId: DriveId, now: number): CloseResult {
    return this.#db.transaction((): CloseResult => {
      const held = this.#rows(
        `SELECT 1 AS found FROM items
         UNION ALL SELECT 1 FROM uploads
         UNION ALL SELECT 1 FROM moves_out LIMIT 1`,
      );
      if (held.length > 0) return { status: "notEmpty" };
      this.#db.exec(
        `INSERT INTO drive_state (id, drive_id, used_bytes, file_count, changed_at, closed)
         VALUES (1, ?, 0, 0, ?, 1)
         ON CONFLICT (id) DO UPDATE SET closed = 1`,
        driveId,
        now,
      );
      return { status: "closed" };
    });
  }

  reopen(): void {
    this.#db.exec("UPDATE drive_state SET closed = 0");
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

  // For a write to D1 that goes ahead of the change, so a crash in between still leaves
  // the retry that puts D1 right.
  flagUsageWrite(driveId: DriveId, now: number): void {
    this.#db.exec(
      `INSERT INTO drive_state (id, drive_id, used_bytes, file_count, changed_at, sync_due_at)
       VALUES (1, ?, 0, 0, ?, ?)
       ON CONFLICT (id) DO UPDATE SET sync_due_at = excluded.sync_due_at`,
      driveId,
      now,
      now + USAGE_RETRY_MS,
    );
  }

  postponeUsageWrite(retryAt: number): void {
    this.#db.exec("UPDATE drive_state SET sync_due_at = ?", retryAt);
  }
}
