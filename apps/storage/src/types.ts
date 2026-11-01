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
  | { status: "noParent" };

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
