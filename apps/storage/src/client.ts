import {
  type AccessLevel,
  checkDriveAccess,
  type DriveGrant,
  type DriveId,
  type DriveRole,
  type UserId,
} from "@cloudysuite/access";
import type { MoveDelivery, ReceiveResult } from "./moves";
import type { ParsedName } from "./names";
import type { Actor } from "./store";
import { driveStub } from "./stub";
import type {
  CloseResult,
  FileItem,
  FolderListing,
  ItemId,
  ItemShares,
  MoveNotice,
  MoveResult,
  NewFolderResult,
  NoAccess,
  OpenedItem,
  RenameResult,
  RestoreResult,
  SearchResult,
  SharedLine,
  ShareResult,
  StarredLine,
  StarResult,
  TrashEntry,
  TrashResult,
} from "./types";
import { createDriveUploads, type DriveUploads } from "./uploads";

export type FileDownload = { file: FileItem; body: ReadableStream };

export type DriveClient = {
  driveId: DriveId;
  // Null for someone not on the drive's list, who reaches only what's shared with them.
  role: DriveRole | null;
  list(
    folderId: ItemId | null,
    cursor: string | null,
  ): Promise<FolderListing | null>;
  opened(id: ItemId): Promise<OpenedItem | null>;
  item(id: ItemId): Promise<OpenedItem["item"] | null>;
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
  // This person's own, newest first.
  moveNotices(): Promise<MoveNotice[]>;
  dismissMoveNotice(moveId: string): Promise<void>;
  mayAddTo(parentId: ItemId | null): Promise<boolean>;
  trash(id: ItemId): Promise<TrashResult>;
  trashEntries(limit: number): Promise<TrashEntry[]>;
  restore(id: ItemId): Promise<RestoreResult>;
  deleteForever(id: ItemId): Promise<NoAccess | void>;
  emptyTrash(): Promise<NoAccess | void>;
  download(id: ItemId): Promise<FileDownload | null>;
  sharePeople(
    id: ItemId,
    people: readonly UserId[],
    level: AccessLevel,
  ): Promise<ShareResult>;
  unshare(id: ItemId, userId: UserId): Promise<ShareResult>;
  setEveryone(id: ItemId, on: boolean): Promise<ShareResult>;
  sharesOn(id: ItemId): Promise<ItemShares | null>;
  sharedWith(limit: number): Promise<SharedLine[]>;
  search(text: string, limit: number): Promise<SearchResult>;
  setStar(id: ItemId, on: boolean): Promise<StarResult>;
  starIds(): Promise<ItemId[]>;
  starred(limit: number): Promise<StarredLine[]>;
  // Only for a manager of a team folder, which the caller has checked.
  close(): Promise<CloseResult>;
  reopen(): Promise<void>;
  uploads: DriveUploads;
};

// The only way for user-facing code to reach a drive. A grant cannot cross RPC, so D1's
// part of the check happens here, on the caller's side. Every method hands who is asking
// to the object, and the object decides what they reach in the call that does the work,
// so nothing can move or be revoked in between. R2 reads also happen here, so large files
// don't pass through the object.
export function openDrive(env: Env, grant: DriveGrant): DriveClient {
  const stub = driveStub(env, grant.driveId);
  const { driveId } = grant;
  const actor: Actor = { userId: grant.userId, role: grant.role };

  const opened = async (id: ItemId) =>
    (await stub.opened(actor, id)) as OpenedItem | null;
  const item = async (id: ItemId) => (await opened(id))?.item ?? null;
  const file = async (id: ItemId) => {
    const found = await item(id);
    return found?.kind === "file" ? found : null;
  };

  return {
    driveId,
    role: grant.role,
    list: async (folderId, cursor) =>
      (await stub.list(actor, folderId, cursor)) as FolderListing | null,
    opened,
    item,
    file,
    recent: async (limit) => (await stub.recent(actor, limit)) as FileItem[],
    createFolder: async (parentId, name) =>
      (await stub.createFolder({
        actor,
        driveId,
        id: crypto.randomUUID() as ItemId,
        parentId,
        name,
      })) as NewFolderResult,

    rename: async (id, name) =>
      (await stub.rename({ actor, driveId, id, name })) as RenameResult,
    mayAddTo: async (parentId) => stub.mayAddTo(actor, parentId),
    async move(id, to, toParentId) {
      if (to.driveId === driveId) {
        return (await stub.moveWithin({
          actor,
          driveId,
          id,
          toParentId,
        })) as MoveResult;
      }
      if (!(await to.mayAddTo(toParentId))) return { status: "noAccess" };
      return (await stub.moveToDrive({
        actor,
        driveId,
        id,
        toDriveId: to.driveId,
        toParentId,
      })) as MoveResult;
    },
    moveNotices: async () => (await stub.moveNotices(actor)) as MoveNotice[],
    dismissMoveNotice: (moveId) => stub.dismissMoveNotice(actor, moveId),
    trash: async (id) =>
      (await stub.trash({ actor, driveId, id })) as TrashResult,
    trashEntries: async (limit) =>
      (await stub.trashEntries(actor, limit)) as TrashEntry[],
    restore: async (id) =>
      (await stub.restore({ actor, driveId, id })) as RestoreResult,
    deleteForever: (id) => stub.deleteForever(actor, id),
    emptyTrash: () => stub.emptyTrash(actor),

    async download(id) {
      const found = await file(id);
      const key = found && (await stub.r2KeyOf(actor, id));
      const object = key ? await env.BUCKET.get(key) : null;
      return found && object ? { file: found, body: object.body } : null;
    },

    sharePeople: async (id, people, level) =>
      (await stub.sharePeople({ actor, id, people, level })) as ShareResult,
    unshare: async (id, userId) =>
      (await stub.unshare({ actor, id, userId })) as ShareResult,
    setEveryone: async (id, on) =>
      (await stub.setEveryone({ actor, id, on })) as ShareResult,
    sharesOn: async (id) =>
      (await stub.sharesOn(actor, id)) as ItemShares | null,
    sharedWith: async (limit) =>
      (await stub.sharedWith(actor, limit)) as SharedLine[],
    search: async (text, limit) =>
      (await stub.search(actor, text, limit)) as SearchResult,
    setStar: async (id, on) =>
      (await stub.setStar({ actor, id, on })) as StarResult,
    starIds: async () => (await stub.starIds(actor)) as ItemId[],
    starred: async (limit) =>
      (await stub.starred(actor, limit)) as StarredLine[],
    close: async () => (await stub.close(driveId)) as CloseResult,
    reopen: () => stub.reopen(),

    uploads: createDriveUploads(env.DB, env.BUCKET, stub, grant),
  };
}

// For one request. A drive that doesn't exist, or a banned person, gets null. Everyone
// else gets a client that reaches what they're allowed to, and nothing else.
export async function openDriveAsPerson(
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
