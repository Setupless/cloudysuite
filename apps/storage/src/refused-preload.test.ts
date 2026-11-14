import { expect, mock, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
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

const { prefetchShared, sharedQuery, StorageFailure, storageQueryClient } =
  await import("./queries");

type Client = ReturnType<typeof storageQueryClient>;

// Every request is refused as signed out, when the test says so.
function signedOutServer(client: Client) {
  const waiting: (() => void)[] = [];
  const answer = () =>
    new Promise<never>((_, reject) => {
      waiting.push(() => reject(new StorageFailure(401, "Signed out")));
    });
  const query = client.query.bind(client);
  client.query = ((options: Parameters<Client["query"]>[0]) =>
    query({ ...options, queryFn: answer })) as Client["query"];
  return {
    answer,
    refuse: () => {
      for (const reject of waiting.splice(0)) reject();
    },
    restore: () => Reflect.deleteProperty(client, "query"),
  };
}

// The page reloads to reach its sign-in check once the session has ended.
function countReloads() {
  const counted = { reloads: 0 };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { reload: () => counted.reloads++ } },
  });
  return counted;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test.each([
  ["after the hover's request was refused", false],
  ["while the hover's request is still out", true],
])(
  "a hover after signing out leaves the page alone, and opening the page %s reloads it",
  async (_, openWhileOut) => {
    const client = storageQueryClient();
    const server = signedOutServer(client);
    const counted = countReloads();
    try {
      await prefetchShared();
      if (!openWhileOut) {
        server.refuse();
        await settled();
        expect(counted.reloads).toBe(0);
      }

      const page = new QueryObserver(client, {
        ...sharedQuery(),
        queryFn: server.answer,
      });
      const close = page.subscribe(() => {});
      await settled();
      server.refuse();
      await settled();
      close();
      expect(counted.reloads).toBe(1);
    } finally {
      Reflect.deleteProperty(globalThis, "window");
      server.restore();
      client.clear();
    }
  },
);
