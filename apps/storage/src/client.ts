import {
  checkDriveAccess,
  type DriveGrant,
  type DriveId,
  type UserId,
} from "@cloudysuite/access";
import type { MoveDelivery, ReceiveResult } from "./moves";
import type { ParsedName } from "./names";
import { driveStub } from "./stub";
import type {
  DriveItem,
  FileItem,
  FolderListing,
  ItemId,
  MoveResult,
  NewFolderResult,
  RenameResult,
  RestoreResult,
  TrashEntry,
  TrashResult,
} from "./types";
import { createDriveUploads, type DriveUploads } from "./uploads";

export type FileDownload = { file: FileItem; body: ReadableStream };

export type DriveClient = {
  driveId: DriveId;
  list(
    folderId: ItemId | null,
    cursor: string | null,
  ): Promise<FolderListing | null>;
  item(id: ItemId): Promise<DriveItem | null>;
  file(id: ItemId): Promise<FileItem | null>;
  recent(limit: number): Promise<FileItem[]>;
  createFolder(
    parentId: ItemId | null,
    name: Extract<ParsedName, { ok: true }>,
  ): Promise<NewFolderResult>;
  rename(
    id: ItemId,
    name: Extract<ParsedName, { ok: true }>,
  ): Promise<RenameResult>;
  // Taking the other drive's client means its access check has already passed.
  move(
    id: ItemId,
    to: DriveClient,
    toParentId: ItemId | null,
  ): Promise<MoveResult>;
  trash(id: ItemId): Promise<TrashResult>;
  trashEntries(limit: number): Promise<TrashEntry[]>;
  restore(id: ItemId): Promise<RestoreResult>;
  deleteForever(id: ItemId): Promise<void>;
  emptyTrash(): Promise<void>;
  download(id: ItemId): Promise<FileDownload | null>;
  uploads: DriveUploads;
};

// The only way for user-facing code to reach a drive. A grant cannot cross RPC, so the
// check happens here, on the caller's side, and the Durable Object trusts its caller.
// R2 reads also happen here, so large files don't pass through the object.
export function openDrive(env: Env, grant: DriveGrant): DriveClient {
  const stub = driveStub(env, grant.driveId);

  const file = async (id: ItemId) => {
    const item = (await stub.item(id)) as DriveItem | null;
    return item?.kind === "file" ? item : null;
  };

  const { driveId } = grant;

  return {
    driveId,
    list: async (folderId, cursor) =>
      (await stub.list(folderId, cursor)) as FolderListing | null,
    item: async (id) => (await stub.item(id)) as DriveItem | null,
    file,
    recent: async (limit) => (await stub.recent(limit)) as FileItem[],
    createFolder: async (parentId, name) =>
      (await stub.createFolder({
        driveId: grant.driveId,
        id: crypto.randomUUID() as ItemId,
        parentId,
        name,
        createdBy: grant.userId,
      })) as NewFolderResult,

    rename: async (id, name) =>
      (await stub.rename({ driveId, id, name })) as RenameResult,
    move: async (id, to, toParentId) =>
      (to.driveId === driveId
        ? await stub.moveWithin({ driveId, id, toParentId })
        : await stub.moveToDrive({
            driveId,
            id,
            toDriveId: to.driveId,
            toParentId,
          })) as MoveResult,
    trash: async (id) => (await stub.trash({ driveId, id })) as TrashResult,
    trashEntries: async (limit) =>
      (await stub.trashEntries(limit)) as TrashEntry[],
    restore: async (id) =>
      (await stub.restore({ driveId, id })) as RestoreResult,
    deleteForever: (id) => stub.deleteForever(id),
    emptyTrash: () => stub.emptyTrash(),

    async download(id) {
      const found = await file(id);
      const key = found && (await stub.r2KeyOf(id));
      const object = key ? await env.BUCKET.get(key) : null;
      return found && object ? { file: found, body: object.body } : null;
    },

    uploads: createDriveUploads(env.DB, env.BUCKET, stub, grant),
  };
}

// The one door for a person changing a drive. For now anyone on a drive can change it,
// and "Can view" will narrow this check.
export async function openDriveToEdit(
  env: Env,
  userId: UserId,
  driveId: DriveId,
): Promise<DriveClient | null> {
  const access = await checkDriveAccess(env.DB, userId, driveId);
  return access.allowed ? openDrive(env, access.grant) : null;
}

// For one drive's object to finish a move into another. The move can outlive the request
// that checked both drives, and this can only deliver that move, so there is no access
// to check by then. Stopping would leave the bytes without an owner who can delete them.
export function moveReceiver(env: Env, driveId: DriveId) {
  const stub = driveStub(env, driveId);
  return {
    receive: async (move: MoveDelivery) =>
      (await stub.receiveMove(move)) as ReceiveResult,
    confirm: async (moveId: string) => {
      await stub.confirmMoveIn(moveId);
    },
    abandon: async (moveId: string) => {
      await stub.abandonMoveIn(moveId, driveId);
    },
  };
}
