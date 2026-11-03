// Shared with the browser, so nothing here may import server code.
import type {
  AccessLevel,
  DriveId,
  DriveKind,
  DriveRole,
  UserId,
} from "@cloudysuite/access";

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
  // Outermost first, not counting the folder itself. Stops at what the person can reach.
  ancestors: FolderItem[];
  contains: number;
  items: DriveItem[];
  nextCursor: string | null;
  // Reached through a share rather than through being on the drive.
  shared: boolean;
  canEdit: boolean;
  // Only when the folder can't be edited: what in it can be, through its own share.
  editableIds: ItemId[];
  // The asking person's own, from anywhere in the drive, newest first.
  moveNotices: MoveNotice[];
};

// Why a move to another drive ended with the item where it was.
export type MoveSetback =
  | { status: "nameTaken" }
  | { status: "noDestination" }
  | { status: "folderBusy" }
  | { status: "overLimit"; bytes: number }
  | { status: "noAnswer" };

// Kept for a person who was told their move was on its way, until they dismiss it.
export type MoveNotice = { moveId: string; name: string; setback: MoveSetback };

// One item as a particular person can see it. A share's own item shows no parent.
export type OpenedItem = { item: DriveItem; canEdit: boolean; shared: boolean };

// Everyone in the organisation can only ever view. Null user ids and an edit level on it
// aren't representable here or in the object's table.
export type ItemShare =
  | {
      kind: "person";
      userId: UserId;
      level: AccessLevel;
      sharedBy: UserId;
      sharedAt: number;
    }
  | {
      kind: "organisation";
      level: "view";
      sharedBy: UserId;
      sharedAt: number;
    };

export type ItemShares = {
  // On this item, so they can be changed from here.
  here: ItemShare[];
  // On a folder it's in.
  above: ItemShare[];
  canEdit: boolean;
};

export type SharedLine = {
  item: DriveItem;
  level: AccessLevel;
  canEdit: boolean;
  sharedBy: UserId;
  sharedAt: number;
};

// A found item, with the names of the folders above it that this person can reach.
export type SearchLine = { item: DriveItem; location: string[] };

export type SearchResult = { lines: SearchLine[]; more: boolean };

export type StarredLine = OpenedItem & { starredAt: number };

export type StarResult = { status: "done" } | { status: "gone" } | NoAccess;

export type ShareResult =
  { status: "done" } | { status: "gone" } | { status: "busy" } | NoAccess;

export type CloseResult = { status: "closed" } | { status: "notEmpty" };

// What a person sees beside a name in "Who can open this".
export type AccessLabel = DriveRole | "owner";

// The same answer whether the item is out of reach or doesn't exist, so changing an id
// can't tell someone what else is in a drive.
export type NoAccess = { status: "noAccess" };

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
  | { status: "folderBusy" }
  | NoAccess;

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
  | { status: "busy" }
  | NoAccess;

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
  | { status: "tooMany" }
  | NoAccess;

export type TrashResult =
  { status: "trashed" } | { status: "gone" } | { status: "busy" } | NoAccess;

export type RestoreResult =
  | { status: "restored"; item: DriveItem; folderGone: boolean }
  | { status: "folderBusy" }
  | { status: "gone" }
  | NoAccess;

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
