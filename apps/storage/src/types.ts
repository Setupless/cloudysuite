// Shared with the browser, so nothing here may import server code.
import type { DriveId, DriveKind, UserId } from "@cloudysuite/access";

export type ItemId = string & { readonly __brand: "ItemId" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const parseItemId = (raw: string): ItemId | null =>
  UUID.test(raw) ? (raw as ItemId) : null;

type ItemFields = {
  id: ItemId;
  // Null is the drive's root.
  parentId: ItemId | null;
  name: string;
  createdBy: UserId;
  createdAt: number;
  changedAt: number;
};

export type FolderItem = ItemFields & { kind: "folder"; contains: number };
export type FileItem = ItemFields & {
  kind: "file";
  size: number;
  mimeType: string;
};
export type DriveItem = FolderItem | FileItem;

export type FolderListing = {
  // Null means the drive's root.
  folder: FolderItem | null;
  // Outermost first, not counting the folder itself.
  ancestors: FolderItem[];
  contains: number;
  items: DriveItem[];
  nextCursor: string | null;
};

export type DriveSummary = {
  id: DriveId;
  kind: DriveKind;
  name: string;
  colour: number;
};

export type Person = { id: UserId; name: string; email: string };

export type NewFolderResult =
  | { status: "created"; item: FolderItem }
  | { status: "nameTaken" }
  | { status: "noParent" }
  | { status: "folderBusy" };

export const TRASH_DAYS = 30;
export const TRASH_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;

// One line of Trash: what the person deleted, with its contents counted but not listed.
export type TrashEntry = {
  id: ItemId;
  kind: "folder" | "file";
  name: string;
  mimeType: string | null;
  // A folder's are everything inside it.
  size: number;
  contains: number;
  trashedAt: number;
  purgeAt: number;
  // Null when it was at the drive's root.
  fromFolder: { name: string | null } | null;
};

export type RenameResult =
  | { status: "renamed"; item: DriveItem }
  | { status: "nameTaken" }
  | { status: "gone" }
  | { status: "busy" };

export type MoveResult =
  | { status: "moved" }
  // The other drive didn't answer. The alarm finishes the move.
  | { status: "pending" }
  | { status: "nameTaken" }
  | { status: "gone" }
  | { status: "noDestination" }
  | { status: "intoItself" }
  | { status: "busy" }
  | { status: "folderBusy" }
  | { status: "overLimit"; bytes: number }
  | { status: "tooMany" };

export type TrashResult =
  { status: "trashed" } | { status: "gone" } | { status: "busy" };

export type RestoreResult =
  | { status: "restored"; item: DriveItem; folderGone: boolean }
  | { status: "folderBusy" }
  | { status: "gone" };

// Two objects can't share a transaction, so what crosses in one must fit in one call.
export const MAX_ITEMS_ACROSS_DRIVES = 2000;

export const NO_SUCH_ITEM =
  "We can't find that. It may have been moved or deleted.";
export const ITEM_BUSY = "This is being moved. Try again in a minute.";
export const FOLDER_BUSY = "That folder is being moved. Try again in a minute.";
export const INTO_ITSELF =
  "A folder can't go inside itself. Choose another folder.";
export const TOO_MANY_TO_MOVE = `This folder holds more than ${MAX_ITEMS_ACROSS_DRIVES} items, which is too many to move to another team folder in one go. Move the folders inside it one at a time.`;

export const nameTakenMessage = (name: string) =>
  `There's already something called "${name}" here. Choose another name.`;

export const NO_SUCH_FOLDER =
  "We can't find that folder. It may no longer exist.";

export type UploadView = {
  id: ItemId;
  name: string;
  size: number;
  storedParts: number[];
};

// A browser runs an SVG or HTML file as a page, and the session cookie reaches this
// host. These four types can't run anything.
export const PREVIEW_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const MAX_PREVIEW_BYTES = 5_000_000;

export const canPreview = (file: { mimeType: string; size: number }) =>
  PREVIEW_TYPES.has(file.mimeType) && file.size <= MAX_PREVIEW_BYTES;
