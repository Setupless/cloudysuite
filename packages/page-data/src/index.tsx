import {
  dehydrate,
  type DehydratedState,
  HydrationBoundary,
  type InfiniteQueryExecuteOptions,
  noop,
  QueryClient,
  type QueryExecuteOptions,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import type { ReactNode } from "react";

// How long the server waits for a page's data before it sends the page without it. Data
// that arrives in time is drawn in the first HTML, so a quick load shows no loading state.
// Later data streams into the same response, and the page shows its own loading state
// until it arrives.
const FIRST_HTML_WAIT_MS = 50;

type PageLoads = {
  query<Data, Key extends QueryKey>(
    options: QueryExecuteOptions<Data, Error, Data, Data, Key>,
  ): Promise<unknown>;
  infinite<Data, Selected, Key extends QueryKey, PageParam>(
    options: InfiniteQueryExecuteOptions<Data, Error, Selected, Key, PageParam>,
  ): Promise<unknown>;
};

// The queries that a route's loader starts for its page.
type PageQueries = (load: PageLoads) => Promise<unknown>[];

// The browser keeps one client for the page, which the route loaders fill and the screens
// read. The server makes a new one each time: a shared one would show one person's data on
// the next person's page. Query never retries on a server, so a query that fails there is
// asked for again by the browser, not by the render.
export function pageQueryClient(create: () => QueryClient): () => QueryClient {
  let browserClient: QueryClient | undefined;
  return () => {
    if (import.meta.env.SSR) return new QueryClient();
    browserClient ??= create();
    return browserClient;
  };
}

// In the browser this returns at once, so a navigation doesn't wait for data and the page
// draws its own loading state. On the server it returns what the first HTML carries.
export function pageData(client: () => QueryClient) {
  return async (queries: PageQueries): Promise<DehydratedState | undefined> =>
    import.meta.env.SSR
      ? firstHtmlData(queries)
      : startInBrowser(client(), queries);
}

// Only what the page doesn't hold yet is asked for, so preloading a page twice asks once:
// what it holds shows at once, and the page's own query asks again as it opens.
function startInBrowser(client: QueryClient, queries: PageQueries): undefined {
  const started = queries({
    query: (options) => client.query({ ...options, staleTime: "static" }),
    infinite: (options) =>
      client.infiniteQuery({ ...options, staleTime: "static" }),
  });
  for (const query of started) query.catch(noop);
  return undefined;
}

// A query still running goes with its promise, which the response streams to the browser
// once it settles. The page's own queries wait on that promise instead of asking again.
// A query that failed is left out, so the page asks for it itself.
export async function firstHtmlData(
  queries: PageQueries,
  waitMs = FIRST_HTML_WAIT_MS,
): Promise<DehydratedState> {
  const client = new QueryClient();
  const started = queries({
    query: (options) => client.query(options),
    infinite: (options) => client.infiniteQuery(options),
  });
  await settledWithin(Promise.allSettled(started), waitMs);
  return dehydrate(client, {
    shouldDehydrateQuery: (query) => query.state.status !== "error",
  });
}

function settledWithin(work: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work, waited]).finally(() => clearTimeout(timer));
}

export function PrefetchedData({
  state,
  children,
}: {
  state: DehydratedState | undefined;
  children: ReactNode;
}) {
  const client = useQueryClient();
  if (!import.meta.env.SSR && state) askAgainIfStreamFails(client, state);
  return <HydrationBoundary state={state}>{children}</HydrationBoundary>;
}

const watched = new WeakSet<Promise<unknown>>();

// A query that fails on the server after the page was sent is asked for again by the page,
// at once and with its own retry rule, as one that failed before is. Left to Query, a
// list's retry would reuse the failed promise and show "redacted".
export function askAgainIfStreamFails(
  client: QueryClient,
  state: DehydratedState,
) {
  for (const { promise, queryKey } of state.queries) {
    if (!promise || watched.has(promise)) continue;
    watched.add(promise);
    promise.catch(() => {
      void client.resetQueries({ queryKey, exact: true });
    });
  }
}
