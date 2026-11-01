import type { DriveGrant } from "@cloudysuite/access";
import type { ParsedName } from "./names";
import { driveStub } from "./stub";
import type {
  DriveItem,
  FileItem,
  FolderListing,
  ItemId,
  NewFolderResult,
} from "./types";
import { createDriveUploads, type DriveUploads } from "./uploads";

export type FileDownload = { file: FileItem; body: ReadableStream };

export type DriveClient = {
  list(
    folderId: ItemId | null,
    cursor: string | null,
  ): Promise<FolderListing | null>;
  file(id: ItemId): Promise<FileItem | null>;
  recent(limit: number): Promise<FileItem[]>;
  createFolder(
    parentId: ItemId | null,
    name: Extract<ParsedName, { ok: true }>,
  ): Promise<NewFolderResult>;
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

  return {
    list: async (folderId, cursor) =>
      (await stub.list(folderId, cursor)) as FolderListing | null,
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

    async download(id) {
      const found = await file(id);
      const key = found && (await stub.r2KeyOf(id));
      const object = key ? await env.BUCKET.get(key) : null;
      return found && object ? { file: found, body: object.body } : null;
    },

    uploads: createDriveUploads(env.BUCKET, stub, grant),
  };
}
