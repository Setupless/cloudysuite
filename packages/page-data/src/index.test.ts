import { afterEach, expect, spyOn, test } from "bun:test";
import {
  hydrate,
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import {
  askAgainIfStreamFails,
  firstHtmlData,
  pageData,
  pageQueryClient,
} from ".";

const FILES = ["files"] as const;

// Data that arrives when the test says so.
function arriving<Data>() {
  let answer!: (data: Data) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<Data>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  return { promise, answer, fail };
}

// What the page shows once the browser has the data, and how often it asked for it.
function openPage(browser: QueryClient) {
  let asked = 0;
  const page = new QueryObserver(browser, {
    queryKey: FILES,
    queryFn: async () => {
      asked += 1;
      return ["asked for again"];
    },
  });
  const shown = new Promise<unknown>((resolve) => {
    page.subscribe((result) => {
      if (result.data) resolve(result.data);
    });
  });
  return { shown, asked: () => asked };
}

// The same for a list that loads a page at a time, as Mail's and Storage's lists do.
function openList(browser: QueryClient) {
  let asked = 0;
  const list = new InfiniteQueryObserver(browser, {
    queryKey: FILES,
    queryFn: async () => {
      asked += 1;
      return ["asked for again"];
    },
    initialPageParam: 0,
    getNextPageParam: () => undefined,
  });
  const shown = new Promise<unknown>((resolve) => {
    list.subscribe((result) => {
      if (result.data) resolve(result.data.pages[0]);
    });
  });
  return { shown, asked: () => asked };
}

afterEach(() => {
  delete process.env.SSR;
});

test("slow data doesn't hold up the first HTML, which carries it later", async () => {
  const files = arriving<string[]>();
  const started = performance.now();
  const state = await firstHtmlData(
    (load) => [load.query({ queryKey: FILES, queryFn: () => files.promise })],
    20,
  );

  expect(performance.now() - started).toBeLessThan(1_000);
  expect(state.queries.map((query) => query.state.status)).toEqual(["pending"]);
  files.answer(["report.pdf"]);
  expect(await state.queries[0]?.promise).toEqual(["report.pdf"]);
});

test("data that arrives in time is in the first HTML itself", async () => {
  const state = await firstHtmlData(
    (load) => [load.query({ queryKey: FILES, queryFn: async () => ["a.pdf"] })],
    1_000,
  );

  expect(state.queries[0]?.state).toMatchObject({
    status: "success",
    data: ["a.pdf"],
  });
  expect(state.queries[0]?.promise).toBeUndefined();
});

test("the browser shows streamed data without asking for it again", async () => {
  const files = arriving<string[]>();
  const state = await firstHtmlData(
    (load) => [load.query({ queryKey: FILES, queryFn: () => files.promise })],
    0,
  );
  const browser = new QueryClient();
  hydrate(browser, state);
  const page = openPage(browser);

  files.answer(["report.pdf"]);

  expect(await page.shown).toEqual(["report.pdf"]);
  expect(page.asked()).toBe(0);
});

test("data that fails before the first HTML is sent is left for the browser to ask for", async () => {
  const state = await firstHtmlData(
    (load) => [
      load.query({
        queryKey: FILES,
        queryFn: async () => {
          throw new Error("Something went wrong on our side.");
        },
      }),
    ],
    1_000,
  );

  expect(state.queries).toEqual([]);
});

test.each(["data", "a list"])(
  "%s that fails after the first HTML is sent is asked for again by the page",
  async (kind) => {
    // Query reports a streamed failure in development builds.
    spyOn(console, "error").mockImplementation(() => {});
    const files = arriving<string[]>();
    const state = await firstHtmlData(
      (load) => [
        kind === "data"
          ? load.query({ queryKey: FILES, queryFn: () => files.promise })
          : load.infinite({
              queryKey: FILES,
              queryFn: () => files.promise,
              initialPageParam: 0,
              getNextPageParam: () => undefined,
            }),
      ],
      0,
    );
    // A client that never retries, so only the page asking again can show the data.
    const browser = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    askAgainIfStreamFails(browser, state);
    hydrate(browser, state);
    const page = kind === "data" ? openPage(browser) : openList(browser);

    files.fail(new Error("Something went wrong on our side."));

    expect(await page.shown).toEqual(["asked for again"]);
    expect(page.asked()).toBe(1);
  },
);

test("on the server a route's loader returns what the first HTML carries", async () => {
  process.env.SSR = "true";
  const firstData = pageData(() => new QueryClient());

  const state = await firstData((load) => [
    load.query({ queryKey: FILES, queryFn: async () => ["a.pdf"] }),
  ]);

  expect(state?.queries[0]?.state.data).toEqual(["a.pdf"]);
});

test("on the server each page gets its own client, so one person's data never reaches the next", () => {
  process.env.SSR = "true";
  const client = pageQueryClient(() => new QueryClient());

  const first = client();
  first.setQueryData(FILES, ["their.pdf"]);

  expect(client().getQueryData(FILES)).toBeUndefined();
});

test("in the browser the loaders and the page share one client", () => {
  const client = pageQueryClient(() => new QueryClient());

  expect(client()).toBe(client());
});
