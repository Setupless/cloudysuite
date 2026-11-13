import { afterEach, expect, mock, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import * as start from "@tanstack/react-start";
import { testWorkerEnv } from "./db/test-database";

mock.module("cloudflare:workers", () => ({
  env: testWorkerEnv,
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Nothing here reaches a server function. Bun loads each module once for the whole run,
// so the apps' server functions load here as the tests that call them expect.
type Handler = (context: { data?: unknown }) => unknown;
const createServerFn = () => ({
  validator: (parse: (raw: unknown) => unknown) => ({
    handler:
      (run: Handler) =>
      async ({ data }: { data: unknown }) =>
        run({ data: parse(data) }),
  }),
  handler: (run: Handler) => () => run({}),
});
mock.module("@tanstack/react-start", () => ({ ...start, createServerFn }));

const calendar = await import("../apps/calendar/src/queries");
const { parseScheduleSearch, placeOf, todayIn, visibleDays } =
  await import("../apps/calendar/src/schedule");
const { deviceZone } = await import("../apps/calendar/src/time");
const { todayWindow } = await import("../apps/calendar/src/ui/today-plan");
const storage = await import("../apps/storage/src/queries");
const tasks = await import("../apps/tasks/src/queries");

type QueryClient = ReturnType<typeof storage.storageQueryClient>;
type QueryKey = readonly unknown[];

// Under Bun these are the browser's clients, the ones a page's screens read.
const clients = [
  calendar.calendarQueryClient(),
  storage.storageQueryClient(),
  tasks.tasksQueryClient(),
];

// Every request a client starts goes to a server that never answers, so a navigation
// that waited for one would never finish.
function holdEveryRequest(): QueryKey[] {
  const asked: QueryKey[] = [];
  for (const client of clients) {
    const query = client.query.bind(client);
    client.query = ((options: Parameters<QueryClient["query"]>[0]) =>
      query({
        ...options,
        queryFn: () => {
          asked.push(options.queryKey);
          return new Promise(() => {});
        },
      })) as QueryClient["query"];
  }
  return asked;
}

afterEach(() => {
  for (const client of clients) {
    Reflect.deleteProperty(client, "query");
    client.clear();
  }
});

function browserRouter(loader: () => Promise<unknown>) {
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/" });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/page",
    loader,
  });
  return createRouter({
    routeTree: root.addChildren([home, page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    isServer: false,
    origin: "https://calendar.example.org",
  });
}

async function within<Result>(work: Promise<Result>, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} waited for data`)),
      1_000,
    );
  });
  try {
    return await Promise.race([work, waited]);
  } finally {
    clearTimeout(timer);
  }
}

const DRIVE = "0d4b2c8e-7a19-4e36-b5f2-8c6a9e1d3b70";
const FOLDER = "9a7e3c1d-2b5f-4d8a-a6c4-1e0f8b3d5c92";
const FILE = "5b3d1f7a-8c2e-4a6b-9d0f-2e4c6a8b0d13";
const BOARD = "4e2a6c8b-1d3f-4a5e-9b7c-6d8f0a2c4e13";
const WEEK = parseScheduleSearch({ date: "2026-11-13" });

const pages: [string, () => Promise<unknown>, () => QueryKey[]][] = [
  [
    "Calendar's sidebar",
    calendar.prefetchCalendars,
    () => [calendar.calendarKeys.calendars],
  ],
  [
    "Calendar's Overview",
    calendar.prefetchOverview,
    () => [
      calendar.calendarKeys.events(
        todayWindow(todayIn(deviceZone(), Date.now())),
      ),
    ],
  ],
  [
    "Calendar's Schedule",
    () => calendar.prefetchSchedule(WEEK),
    () => [
      calendar.calendarKeys.events(
        visibleDays(placeOf(WEEK, todayIn(deviceZone(), Date.now()))),
      ),
    ],
  ],
  [
    "Storage's sidebar",
    storage.prefetchDirectory,
    () => [storage.storageKeys.directory, storage.storageKeys.moveNotices],
  ],
  [
    "Storage's Home",
    storage.prefetchHome,
    () => [storage.storageKeys.recent(4)],
  ],
  [
    "Storage's Recent",
    storage.prefetchRecent,
    () => [storage.storageKeys.recent(50)],
  ],
  [
    "Storage's Shared",
    storage.prefetchShared,
    () => [storage.storageKeys.shared],
  ],
  [
    "Storage's Starred",
    storage.prefetchStarred,
    () => [storage.storageKeys.starred],
  ],
  ["Storage's Trash", storage.prefetchTrash, () => [storage.storageKeys.trash]],
  [
    "a Storage search with a date",
    () => storage.prefetchSearch("report after:2026-01-01"),
    () => [storage.storageKeys.search("report after:2026-01-01")],
  ],
  [
    "a drive",
    () => storage.prefetchFolder(DRIVE),
    () => [storage.storageKeys.folder(DRIVE as never, null)],
  ],
  [
    "a folder",
    () => storage.prefetchFolder(DRIVE, FOLDER),
    () => [storage.storageKeys.folder(DRIVE as never, FOLDER as never)],
  ],
  [
    "a file",
    () => storage.prefetchFile(DRIVE, FILE),
    () => [storage.storageKeys.file(DRIVE as never, FILE as never)],
  ],
  [
    "Tasks' sidebar",
    tasks.prefetchBoards,
    () => [tasks.tasksKeys.boards, tasks.tasksKeys.moveNotices],
  ],
  ["My tasks", tasks.prefetchMyTasks, () => [tasks.tasksKeys.mine]],
  [
    "a board",
    () => tasks.prefetchBoard(BOARD),
    () => [tasks.tasksKeys.board(BOARD as never)],
  ],
];

test.each(pages)(
  "opening %s in the browser asks for its data and doesn't wait for it",
  async (_, loader, keys) => {
    const asked = holdEveryRequest();
    const router = browserRouter(loader);
    await router.load();

    await within(router.navigate({ href: "/page" }), "The navigation");

    expect(router.state.location.pathname).toBe("/page");
    expect(router.state.status).toBe("idle");
    expect(asked).toEqual(keys());
  },
);

test("preloading a page again, or one whose data the browser holds, asks nothing more", async () => {
  const asked = holdEveryRequest();
  const router = browserRouter(storage.prefetchShared);
  await router.load();

  await within(router.preloadRoute({ to: "/page" }), "The first preload");
  await within(router.preloadRoute({ to: "/page" }), "The second preload");
  expect(asked).toEqual([storage.storageKeys.shared]);

  // Held data shows at once and the page asks again as it opens, so even old data isn't
  // asked for by a preload.
  const held = browserRouter(storage.prefetchTrash);
  storage.storageQueryClient().setQueryData(storage.storageKeys.trash, [], {
    updatedAt: Date.now() - 60 * 60 * 1000,
  });
  await held.load();
  await within(held.preloadRoute({ to: "/page" }), "The preload");
  expect(asked).toEqual([storage.storageKeys.shared]);
});
