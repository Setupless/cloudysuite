import {
  dehydrate,
  infiniteQueryOptions,
  QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { MailFailure, NotSavedOnDevice } from "./failure";
import {
  findThreadOfMessage,
  getMessageBody,
  getThread,
  listMailboxes,
  listThreads,
  searchThreads,
} from "./functions";
import { type MailListing, parseViewParam, viewParam } from "./model";
import {
  isOffline,
  OFFLINE_ACTION_REFUSED,
  readBody,
  readMailboxes,
  readRules,
  readSearchPage,
  readThread,
  readThreadPage,
} from "./pwa/saved-mail";
import { getRules } from "./rules/functions";
import type { SearchPage } from "./search/store";
import { getSenderLists } from "./spam/functions";
import type { MailboxId, MessageId, ThreadId } from "./types";

export const REFRESH_MS = 30_000;

const CANNOT_REACH =
  "We couldn't reach CloudySuite. Check your connection and try again.";
const SOMETHING_WENT_WRONG =
  "Something went wrong on our side. Try again in a moment.";

export { MailFailure };

// A refusal from a server function arrives as a thrown Response. What the person
// sees is the plain message the server wrote, or a plain message from here.
export async function asMailFailure(thrown: unknown): Promise<MailFailure> {
  if (thrown instanceof MailFailure) return thrown;
  if (!(thrown instanceof Response)) return new MailFailure(0, CANNOT_REACH);
  const body = (await thrown
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown } | null;
  return new MailFailure(
    thrown.status,
    typeof body?.message === "string" ? body.message : SOMETHING_WENT_WRONG,
  );
}

export async function call<Result>(run: () => Promise<Result>) {
  try {
    return await run();
  } catch (thrown) {
    throw await asMailFailure(thrown);
  }
}

// Refused before it runs and never queued, so nothing happens later by surprise.
export async function callAction<Result>(run: () => Promise<Result>) {
  if (isOffline()) throw new MailFailure(0, OFFLINE_ACTION_REFUSED);
  return call(run);
}

export const mailKeys = {
  mailboxes: ["mail", "mailboxes"] as const,
  all: (mailboxId: MailboxId) => ["mail", mailboxId] as const,
  threads: (mailboxId: MailboxId) => ["mail", mailboxId, "threads"] as const,
  rules: (mailboxId: MailboxId) => ["mail", mailboxId, "rules"] as const,
  senders: (mailboxId: MailboxId) => ["mail", mailboxId, "senders"] as const,
  threadsIn: (mailboxId: MailboxId, listing: MailListing) =>
    "search" in listing
      ? (["mail", mailboxId, "threads", "search", listing.search] as const)
      : (["mail", mailboxId, "threads", viewParam(listing)] as const),
  thread: (mailboxId: MailboxId, threadId: ThreadId) =>
    ["mail", mailboxId, "thread", threadId] as const,
  body: (mailboxId: MailboxId, messageId: MessageId) =>
    ["mail", mailboxId, "body", messageId] as const,
  invitation: (mailboxId: MailboxId, messageId: MessageId) =>
    ["mail", mailboxId, "invitation", messageId] as const,
};

// A message's content never changes, so a refresh after an action skips the bodies
// it already holds. A body that failed to load still retries.
export function refreshMailbox(queryClient: QueryClient, mailboxId: MailboxId) {
  void queryClient.invalidateQueries({
    queryKey: mailKeys.all(mailboxId),
    predicate: (query) =>
      query.queryKey[2] !== "body" || query.state.status !== "success",
  });
  return queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
}

export const mailboxesQuery = () =>
  queryOptions({
    queryKey: mailKeys.mailboxes,
    queryFn: () => call(() => readMailboxes(() => listMailboxes())),
  });

function readListing(
  mailboxId: MailboxId,
  listing: MailListing,
  cursor: string | undefined,
): Promise<SearchPage> {
  return call(() => {
    if ("search" in listing) {
      return readSearchPage(() =>
        searchThreads({
          data: {
            mailboxId,
            text: listing.search,
            offsetMinutes: new Date().getTimezoneOffset(),
            cursor,
          },
        }),
      );
    }
    return readThreadPage(
      () => listThreads({ data: { mailboxId, view: listing, cursor } }),
      mailboxId,
      listing,
    );
  });
}

export const threadsQuery = (mailboxId: MailboxId, listing: MailListing) =>
  infiniteQueryOptions({
    queryKey: mailKeys.threadsIn(mailboxId, listing),
    queryFn: ({ pageParam }) => readListing(mailboxId, listing, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const rulesQuery = (mailboxId: MailboxId) =>
  queryOptions({
    queryKey: mailKeys.rules(mailboxId),
    queryFn: () =>
      call(() => readRules(() => getRules({ data: { mailboxId } }))),
  });

export const sendersQuery = (mailboxId: MailboxId) =>
  queryOptions({
    queryKey: mailKeys.senders(mailboxId),
    queryFn: () => call(() => getSenderLists({ data: { mailboxId } })),
  });

export const threadQuery = (mailboxId: MailboxId, threadId: ThreadId) =>
  queryOptions({
    queryKey: mailKeys.thread(mailboxId, threadId),
    queryFn: () =>
      call(() =>
        readThread(
          () => getThread({ data: { mailboxId, threadId } }),
          mailboxId,
          threadId,
        ),
      ),
  });

// A message's content never changes, so one read is enough until the cache forgets it.
export const bodyQuery = (mailboxId: MailboxId, messageId: MessageId) =>
  queryOptions({
    queryKey: mailKeys.body(mailboxId, messageId),
    queryFn: () =>
      call(() =>
        readBody(
          () => getMessageBody({ data: { mailboxId, messageId } }),
          mailboxId,
          messageId,
        ),
      ),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60 * 1000,
  });

export const threadOfMessageQuery = (
  mailboxId: MailboxId,
  messageId: MessageId,
) =>
  queryOptions({
    queryKey: ["mail", mailboxId, "threadOfMessage", messageId] as const,
    queryFn: () =>
      call(() => findThreadOfMessage({ data: { mailboxId, messageId } })),
    staleTime: 0,
    gcTime: 0,
  });

export const isRefusal = (error: Error): boolean =>
  error instanceof MailFailure && error.status >= 400 && error.status < 500;

export const retryUnlessRefused = (failures: number, error: Error): boolean =>
  !isRefusal(error) && !(error instanceof NotSavedOnDevice) && failures < 2;

// The first HTML holds the mail, so a reload shows the list and not a skeleton.
// A failed prefetch leaves the query empty, and the page shows the failure.
export async function prefetchMailboxes() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(mailboxesQuery());
  return dehydrate(client);
}

export async function prefetchRules(mailboxId: string) {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(rulesQuery(mailboxId as MailboxId));
  return dehydrate(client);
}

export async function prefetchSenders(mailboxId: string) {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(sendersQuery(mailboxId as MailboxId));
  return dehydrate(client);
}

export async function prefetchThreads(mailboxId: string, viewRaw: string) {
  if (!import.meta.env.SSR) return undefined;
  const view = parseViewParam(viewRaw);
  if (!view) return undefined;
  const client = new QueryClient();
  await client.prefetchInfiniteQuery(
    threadsQuery(mailboxId as MailboxId, view),
  );
  return dehydrate(client);
}
