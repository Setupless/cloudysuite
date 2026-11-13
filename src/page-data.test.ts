import {
  afterEach,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
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

const calendar = await import("../apps/calendar/src/queries");
const { parseScheduleSearch } = await import("../apps/calendar/src/schedule");
const storage = await import("../apps/storage/src/queries");
const tasks = await import("../apps/tasks/src/queries");
const mail = await import("../apps/mail/src/queries");

type QueryClient = ReturnType<typeof storage.storageQueryClient>;
type QueryKey = readonly unknown[];

// Under Bun these are the browser's clients, the ones a page's screens read.
const clients = [
  calendar.calendarQueryClient(),
  storage.storageQueryClient(),
  tasks.tasksQueryClient(),
  mail.mailQueryClient(),
];

// A reader in Auckland, where Monday 16 November has begun. UTC is still on Sunday the
// 15th, a week earlier, so a loader that asks for UTC's days asks for the wrong week.
const READER_ZONE = "Pacific/Auckland";
const NOW = new Date("2026-11-15T11:00:00Z");
const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeEach(() => {
  process.env.TZ = READER_ZONE;
  setSystemTime(NOW);
});

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
  setSystemTime();
  process.env.TZ = hostZone;
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
const MAILBOX = "6f1d2c1e-8a0b-4d7e-9c55-0a1b2c3d4e5f";
const WEEK = parseScheduleSearch({ date: "2026-11-13" });

type Page = {
  name: string;
  client: () => QueryClient;
  load: () => Promise<unknown>;
  // What the page asks for, named without calling the code under test.
  keys: () => QueryKey[];
};

const pagesOf = (
  client: Page["client"],
  rows: [string, Page["load"], Page["keys"]][],
): Page[] => rows.map(([name, load, keys]) => ({ name, client, load, keys }));

const days = (from: string, to: string) =>
  calendar.calendarKeys.events({ from, to } as never);

const pages: Page[] = [
  ...pagesOf(calendar.calendarQueryClient, [
    [
      "Calendar's sidebar",
      calendar.prefetchCalendars,
      () => [calendar.calendarKeys.calendars],
    ],
    [
      "Calendar's Overview",
      calendar.prefetchOverview,
      () => [days("2026-11-16", "2026-11-23")],
    ],
    [
      "Calendar's Schedule on the reader's today",
      () => calendar.prefetchSchedule(parseScheduleSearch({})),
      () => [days("2026-11-16", "2026-11-23")],
    ],
    [
      "Calendar's Schedule on a date",
      () => calendar.prefetchSchedule(WEEK),
      () => [days("2026-11-09", "2026-11-16")],
    ],
  ]),
  ...pagesOf(storage.storageQueryClient, [
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
    [
      "Storage's Trash",
      storage.prefetchTrash,
      () => [storage.storageKeys.trash],
    ],
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
  ]),
  ...pagesOf(tasks.tasksQueryClient, [
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
  ]),
  ...pagesOf(mail.mailQueryClient, [
    [
      "Mail's mailbox list",
      mail.prefetchMailboxes,
      () => [mail.mailKeys.mailboxes],
    ],
    [
      "a mail folder",
      () => mail.prefetchThreads(MAILBOX, "inbox"),
      () => [mail.mailKeys.threadsIn(MAILBOX as never, { folder: "inbox" })],
    ],
    [
      "a mail label",
      () => mail.prefetchThreads(MAILBOX, "label-3"),
      () => [
        mail.mailKeys.threadsIn(MAILBOX as never, { labelId: 3 as never }),
      ],
    ],
    [
      "a mailbox's rules",
      () => mail.prefetchRules(MAILBOX),
      () => [mail.mailKeys.rules(MAILBOX as never)],
    ],
    [
      "a mailbox's senders",
      () => mail.prefetchSenders(MAILBOX),
      () => [mail.mailKeys.senders(MAILBOX as never)],
    ],
  ]),
];

test.each(pages)(
  "opening $name in the browser asks for its data and doesn't wait for it",
  async ({ load, keys }) => {
    const asked = holdEveryRequest();
    const router = browserRouter(load);
    await router.load();

    await within(router.navigate({ href: "/page" }), "The navigation");

    expect(router.state.location.pathname).toBe("/page");
    expect(router.state.status).toBe("idle");
    expect(asked).toEqual(keys());
  },
);

test.each(pages)(
  "preloading $name again asks nothing more",
  async ({ load, keys }) => {
    const asked = holdEveryRequest();
    const router = browserRouter(load);
    await router.load();

    await within(router.preloadRoute({ to: "/page" }), "The first preload");
    await within(router.preloadRoute({ to: "/page" }), "The second preload");

    expect(asked).toEqual(keys());
  },
);

// Held data shows at once and the page asks again as it opens, so even old data isn't
// asked for by a preload. A loader that awaits its data and keeps `staleTime: "static"`
// passes here, because held data answers it at once. The first two checks catch it.
test.each(pages)(
  "preloading $name doesn't refresh data the browser holds",
  async ({ client, load, keys }) => {
    const asked = holdEveryRequest();
    for (const key of keys()) {
      client().setQueryData(key, [], {
        updatedAt: Date.now() - 60 * 60 * 1000,
      });
    }
    const router = browserRouter(load);
    await router.load();

    await within(router.preloadRoute({ to: "/page" }), "The preload");

    expect(asked).toEqual([]);
  },
);
