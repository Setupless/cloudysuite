import {
  dehydrate,
  infiniteQueryOptions,
  keepPreviousData,
  MutationCache,
  noop,
  type Query,
  QueryCache,
  QueryClient,
  type QueryExecuteOptions,
  type QueryKey,
  queryOptions,
} from "@tanstack/react-query";
import type { DriveId } from "@cloudysuite/access";
import {
  getDirectory,
  getFile,
  getFolder,
  getMoveNotices,
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
import { parseSearch } from "./search-query";
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

// An expired session surfaces here first. The reload reaches the route's sign-in check,
// which sends the person to sign in and back again.
function reloadIfSignedOut(error: Error) {
  if (error instanceof StorageFailure && error.status === 401) {
    window.location.reload();
  }
}

function createStorageQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reloadIfSignedOut }),
    mutationCache: new MutationCache({ onError: reloadIfSignedOut }),
    defaultOptions: {
      mutations: { networkMode: "always" },
      queries: {
        networkMode: "always",
        // Only long enough that the first HTML's files aren't fetched again as the page
        // wakes up. Opening a folder after that asks the server.
        staleTime: 2_000,
        retry: retryUnlessRefused,
        refetchOnWindowFocus: true,
      },
    },
  });
}

let browserClient: QueryClient | undefined;

// The browser keeps one for the page, which the route loaders fill and the screens read.
// The server makes a new one each time: a shared one would leak one person's files into
// the next person's page.
export function storageQueryClient(): QueryClient {
  if (import.meta.env.SSR) return createStorageQueryClient();
  browserClient ??= createStorageQueryClient();
  return browserClient;
}

export const storageKeys = {
  all: ["storage"] as const,
  directory: ["storage", "directory"] as const,
  moveNotices: ["storage", "move-notices"] as const,
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

// Search and mail attachments can take seconds, and no change shows its outcome
// there, so a dialog waiting on this doesn't wait for them.
const refreshesBehind = (query: Query) =>
  query.queryKey[1] === storageKeys.search("")[1] ||
  query.queryKey[1] === storageKeys.mailAttachments[1];

// Resolves once every list a change shows up in has its new contents.
export async function refreshStorage(client: QueryClient) {
  void client.invalidateQueries({
    queryKey: storageKeys.all,
    predicate: refreshesBehind,
  });
  await client.invalidateQueries({
    queryKey: storageKeys.all,
    predicate: (query) => !refreshesBehind(query),
  });
}

export const directoryQuery = () =>
  queryOptions({
    queryKey: storageKeys.directory,
    queryFn: () => call(() => getDirectory()),
  });

// Every page shows these, and asks again as it opens, so a note written while the person
// was elsewhere shows on the next page they go to.
export const moveNoticesQuery = () =>
  queryOptions({
    queryKey: storageKeys.moveNotices,
    queryFn: () => call(() => getMoveNotices()),
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
    queryFn: () =>
      call(() =>
        searchEverything({
          data: {
            text,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        }),
      ),
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

// In the browser a navigation starts the page's first requests and doesn't wait for them,
// so the page draws its own loading state meanwhile. Only what the page doesn't hold yet
// is asked for, so preloading a page twice asks once: what it holds shows at once, and
// the page's own query asks again as it opens.
function startInBrowser<Data, Key extends QueryKey>(
  query: QueryExecuteOptions<Data, Error, Data, Data, Key>,
) {
  void storageQueryClient()
    .query({ ...query, staleTime: "static" })
    .catch(noop);
  return undefined;
}

// The first HTML holds the files, so a reload shows the page and not a skeleton. A
// failed prefetch leaves the query empty, and the page shows the failure.
export async function prefetchDirectory() {
  if (!import.meta.env.SSR) {
    startInBrowser(directoryQuery());
    startInBrowser(moveNoticesQuery());
    return undefined;
  }
  const client = new QueryClient();
  await Promise.all([
    client.prefetchQuery(directoryQuery()),
    client.prefetchQuery(moveNoticesQuery()),
  ]);
  return dehydrate(client);
}

export async function prefetchHome() {
  if (!import.meta.env.SSR) return startInBrowser(recentQuery(4));
  const client = new QueryClient();
  await client.prefetchQuery(recentQuery(4));
  return dehydrate(client);
}

export async function prefetchRecent() {
  if (!import.meta.env.SSR) return startInBrowser(recentQuery(50));
  const client = new QueryClient();
  await client.prefetchQuery(recentQuery(50));
  return dehydrate(client);
}

export async function prefetchShared() {
  if (!import.meta.env.SSR) return startInBrowser(sharedQuery());
  const client = new QueryClient();
  await client.prefetchQuery(sharedQuery());
  return dehydrate(client);
}

// The page asks only for a search that reads. A date in the search needs the reader's
// time zone, which the browser knows and the server doesn't.
export async function prefetchSearch(text: string) {
  const parsed = parseSearch(text, "UTC");
  if (!import.meta.env.SSR) {
    return parsed.ok ? startInBrowser(searchQuery(text)) : undefined;
  }
  const client = new QueryClient();
  if (
    parsed.ok &&
    parsed.query.changedAfter === null &&
    parsed.query.changedBefore === null
  ) {
    await client.prefetchQuery(searchQuery(text));
  }
  return dehydrate(client);
}

export async function prefetchStarred() {
  if (!import.meta.env.SSR) return startInBrowser(starredQuery());
  const client = new QueryClient();
  await client.prefetchQuery(starredQuery());
  return dehydrate(client);
}

export async function prefetchFile(driveId: string, fileId: string) {
  const query = fileQuery(driveId as DriveId, fileId as ItemId);
  if (!import.meta.env.SSR) return startInBrowser(query);
  const client = new QueryClient();
  await client.prefetchQuery(query);
  return dehydrate(client);
}

export async function prefetchTrash() {
  if (!import.meta.env.SSR) return startInBrowser(trashQuery());
  const client = new QueryClient();
  await client.prefetchQuery(trashQuery());
  return dehydrate(client);
}

export async function prefetchFolder(driveId: string, folderId?: string) {
  const query = folderQuery(
    driveId as DriveId,
    (folderId ?? null) as ItemId | null,
  );
  if (!import.meta.env.SSR) {
    void storageQueryClient()
      .infiniteQuery({ ...query, staleTime: "static" })
      .catch(noop);
    return undefined;
  }
  const client = new QueryClient();
  await client.prefetchInfiniteQuery(query);
  return dehydrate(client);
}
