import { expect, mock, test } from "bun:test";
import { type QueryClient, QueryObserver } from "@tanstack/react-query";
import { testWorkerEnv } from "../../../src/db/test-database";

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

const calendar = await import("../../calendar/src/queries");
const storage = await import("../../storage/src/queries");
const tasks = await import("../../tasks/src/queries");
const mail = await import("./queries");

type Failure = new (status: number, message: string) => Error;

const APPS: [string, () => QueryClient, Failure][] = [
  ["Calendar", calendar.calendarQueryClient, calendar.CalendarFailure],
  ["Storage", storage.storageQueryClient, storage.StorageFailure],
  ["Tasks", tasks.tasksQueryClient, tasks.TasksFailure],
  ["Mail", mail.mailQueryClient, mail.MailFailure],
];

// The page reloads to reach its sign-in check once the session has ended. Mail clears
// what it saved on this device first, so these globals let it.
function signedOutBrowser() {
  const counted = { reloads: 0 };
  const globals: Record<string, unknown> = {
    window: { location: { reload: () => counted.reloads++ } },
    caches: { keys: async () => [], delete: async () => true },
    indexedDB: {
      deleteDatabase: () => {
        const request: { onsuccess?: () => void } = {};
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  return {
    counted,
    restore: () => {
      for (const name of Object.keys(globals)) {
        Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

const settled = async () => {
  for (let step = 0; step < 3; step++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

test.each(APPS)(
  "%s: a hover's refused load changes nothing, and the page that shows it reloads",
  async (_, queryClient, AppFailure) => {
    const client = queryClient();
    const { counted, restore } = signedOutBrowser();
    const refuse = async () => {
      throw new AppFailure(401, "Sign in first.");
    };
    const queryKey = ["refused"];
    try {
      await client.prefetchQuery({ queryKey, queryFn: refuse, retry: false });
      await settled();
      expect(counted.reloads).toBe(0);

      const page = new QueryObserver(client, {
        queryKey,
        queryFn: refuse,
        retry: false,
      });
      const close = page.subscribe(() => {});
      await settled();
      close();
      expect(counted.reloads).toBe(1);
    } finally {
      restore();
      client.clear();
    }
  },
);

test.each(APPS)(
  "%s: a refused change reloads the page",
  async (_, queryClient, AppFailure) => {
    const client = queryClient();
    const { counted, restore } = signedOutBrowser();
    try {
      const change = client
        .getMutationCache()
        .build(client, {
          mutationFn: async () => {
            throw new AppFailure(401, "Sign in first.");
          },
        })
        .execute(undefined)
        .catch((thrown: unknown) => thrown);
      expect(await change).toBeInstanceOf(AppFailure);
      await settled();
      expect(counted.reloads).toBe(1);
    } finally {
      restore();
      client.clear();
    }
  },
);
