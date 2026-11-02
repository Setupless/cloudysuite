import {
  dehydrate,
  infiniteQueryOptions,
  keepPreviousData,
  QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import type { DriveId } from "@cloudysuite/access";
import {
  getDirectory,
  getFile,
  getFolder,
  getRecent,
  getTrash,
} from "./functions";
import { getMailAttachments } from "./mail-attachment-functions";
import {
  getAccess,
  getShareChoices,
  getSharedWithMe,
} from "./sharing-functions";
import { getStarIds, getStarred, searchEverything } from "./search-functions";
import type { ItemId } from "./types";

const CANNOT_REACH =
  "We couldn't reach CloudySuite. Check your connection and try again.";
const SOMETHING_WENT_WRONG =
  "Something went wrong on our side. Try again in a moment.";

export class StorageFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// A refusal from a server function arrives as a thrown Response. What the person
// sees is the plain message the server wrote, or a plain message from here.
async function asFailure(thrown: unknown): Promise<StorageFailure> {
  if (thrown instanceof StorageFailure) return thrown;
  if (!(thrown instanceof Response)) return new StorageFailure(0, CANNOT_REACH);
  const body = (await thrown
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown } | null;
  return new StorageFailure(
    thrown.status,
    typeof body?.message === "string" ? body.message : SOMETHING_WENT_WRONG,
  );
}

export async function call<Result>(run: () => Promise<Result>) {
  try {
    return await run();
  } catch (thrown) {
    throw await asFailure(thrown);
  }
}

export const retryUnlessRefused = (failures: number, error: Error): boolean =>
  !(
    error instanceof StorageFailure &&
    error.status >= 400 &&
    error.status < 500
  ) && failures < 2;

export const storageKeys = {
  all: ["storage"] as const,
  directory: ["storage", "directory"] as const,
  folder: (driveId: DriveId, folderId: ItemId | null) =>
    ["storage", "folder", driveId, folderId] as const,
  file: (driveId: DriveId, fileId: ItemId) =>
    ["storage", "file", driveId, fileId] as const,
  recent: (limit: number) => ["storage", "recent", limit] as const,
  mailAttachments: ["storage", "mailAttachments"] as const,
  trash: ["storage", "trash"] as const,
  access: (driveId: DriveId, itemId: ItemId | null) =>
    ["storage", "access", driveId, itemId] as const,
  shareChoices: ["storage", "share-choices"] as const,
  shared: ["storage", "shared"] as const,
  search: (text: string) => ["storage", "search", text] as const,
  starred: ["storage", "starred"] as const,
  starIds: (driveId: DriveId) => ["storage", "star-ids", driveId] as const,
};

export const directoryQuery = () =>
  queryOptions({
    queryKey: storageKeys.directory,
    queryFn: () => call(() => getDirectory()),
  });

export const folderQuery = (driveId: DriveId, folderId: ItemId | null) =>
  infiniteQueryOptions({
    queryKey: storageKeys.folder(driveId, folderId),
    queryFn: ({ pageParam }) =>
      call(() => getFolder({ data: { driveId, folderId, cursor: pageParam } })),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

export const fileQuery = (driveId: DriveId, fileId: ItemId) =>
  queryOptions({
    queryKey: storageKeys.file(driveId, fileId),
    queryFn: () => call(() => getFile({ data: { driveId, fileId } })),
  });

export const recentQuery = (limit: 4 | 50) =>
  queryOptions({
    queryKey: storageKeys.recent(limit),
    queryFn: () => call(() => getRecent({ data: { limit } })),
  });

// Not prefetched, so a slow mailbox can't hold up Home. No retry, because the section
// is only left out when this fails.
export const mailAttachmentsQuery = () =>
  queryOptions({
    queryKey: storageKeys.mailAttachments,
    queryFn: () => call(() => getMailAttachments()),
    retry: false,
    // Each read wakes every mailbox the person can reach, so returning to the tab
    // doesn't ask again right away.
    staleTime: 60_000,
  });

export const trashQuery = () =>
  queryOptions({
    queryKey: storageKeys.trash,
    queryFn: () => call(() => getTrash()),
  });

export const accessQuery = (driveId: DriveId, itemId: ItemId | null) =>
  queryOptions({
    queryKey: storageKeys.access(driveId, itemId),
    queryFn: () => call(() => getAccess({ data: { driveId, itemId } })),
  });

export const shareChoicesQuery = () =>
  queryOptions({
    queryKey: storageKeys.shareChoices,
    queryFn: () => call(() => getShareChoices()),
  });

export const sharedQuery = () =>
  queryOptions({
    queryKey: storageKeys.shared,
    queryFn: () => call(() => getSharedWithMe()),
  });

export const searchQuery = (text: string) =>
  queryOptions({
    queryKey: storageKeys.search(text),
    queryFn: () => call(() => searchEverything({ data: { text } })),
    placeholderData: keepPreviousData,
  });

export const starredQuery = () =>
  queryOptions({
    queryKey: storageKeys.starred,
    queryFn: () => call(() => getStarred()),
  });

export const starIdsQuery = (driveId: DriveId) =>
  queryOptions({
    queryKey: storageKeys.starIds(driveId),
    queryFn: () => call(() => getStarIds({ data: { driveId } })),
  });

// The first HTML holds the files, so a reload shows the page and not a skeleton. A
// failed prefetch leaves the query empty, and the page shows the failure.
export async function prefetchDirectory() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(directoryQuery());
  return dehydrate(client);
}

export async function prefetchHome() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(recentQuery(4));
  return dehydrate(client);
}

export async function prefetchRecent() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(recentQuery(50));
  return dehydrate(client);
}

export async function prefetchShared() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(sharedQuery());
  return dehydrate(client);
}

export async function prefetchSearch(text: string) {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  if (text.trim() !== "") await client.prefetchQuery(searchQuery(text));
  return dehydrate(client);
}

export async function prefetchStarred() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(starredQuery());
  return dehydrate(client);
}

export async function prefetchFile(driveId: string, fileId: string) {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(fileQuery(driveId as DriveId, fileId as ItemId));
  return dehydrate(client);
}

export async function prefetchTrash() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(trashQuery());
  return dehydrate(client);
}

export async function prefetchFolder(driveId: string, folderId?: string) {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchInfiniteQuery(
    folderQuery(driveId as DriveId, (folderId ?? null) as ItemId | null),
  );
  return dehydrate(client);
}
