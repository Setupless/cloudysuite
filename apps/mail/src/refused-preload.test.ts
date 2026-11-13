import { expect, mock, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import { testWorkerEnv } from "../../../src/db/test-database";
import type { MailboxId } from "./types";

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

const {
  fetchForClick,
  MailFailure,
  mailQueryClient,
  prefetchRules,
  rulesQuery,
} = await import("./queries");

type Client = ReturnType<typeof mailQueryClient>;

const MAILBOX = "mailbox-1" as MailboxId;

// Every request is refused as signed out, when the test says so.
function signedOutServer(client: Client) {
  const waiting: (() => void)[] = [];
  const answer = () =>
    new Promise<never>((_, reject) => {
      waiting.push(() => reject(new MailFailure(401, "Sign in first.")));
    });
  const query = client.query.bind(client);
  client.query = ((options: Parameters<Client["query"]>[0]) =>
    query({ ...options, queryFn: answer })) as Client["query"];
  return {
    rules: { ...rulesQuery(MAILBOX), queryFn: answer },
    refuse: () => {
      for (const reject of waiting.splice(0)) reject();
    },
    restore: () => Reflect.deleteProperty(client, "query"),
  };
}

// What this browser holds for Mail, and how often the page loaded again.
function savedMailDevice() {
  const device = {
    reloads: 0,
    caches: new Set(["cloudysuite-mail-1"]),
    databases: new Set(["cloudysuite-mail"]),
  };
  const globals: Record<string, unknown> = {
    window: { location: { reload: () => device.reloads++ } },
    caches: {
      keys: async () => [...device.caches],
      delete: async (name: string) => device.caches.delete(name),
    },
    indexedDB: {
      deleteDatabase: () => {
        const request: { onsuccess?: () => void } = {};
        queueMicrotask(() => {
          device.databases.clear();
          request.onsuccess?.();
        });
        return request;
      },
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  return {
    device,
    restore: () => {
      for (const name of Object.keys(globals)) {
        Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a hover after signing out keeps the saved mail, and opening the page clears it", async () => {
  const client = mailQueryClient();
  const server = signedOutServer(client);
  const { device, restore } = savedMailDevice();
  try {
    await prefetchRules(MAILBOX);
    server.refuse();
    await settled();
    expect(device).toMatchObject({ reloads: 0 });
    expect(device.caches.size).toBe(1);
    const page = new QueryObserver(client, server.rules);
    const close = page.subscribe(() => {});
    await settled();
    server.refuse();
    await settled();
    await settled();
    close();
    expect(device.reloads).toBe(1);
    expect(device.caches.size).toBe(0);
    expect(device.databases.size).toBe(0);
  } finally {
    restore();
    server.restore();
    client.clear();
  }
});

test.each([
  ["with nothing else asking", false],
  ["while a hover's request is still out", true],
])(
  "a click that reads the rules after signing out clears the saved mail %s",
  async (_, hoverFirst) => {
    const client = mailQueryClient();
    const server = signedOutServer(client);
    const { device, restore } = savedMailDevice();
    try {
      if (hoverFirst) await prefetchRules(MAILBOX);
      const click = fetchForClick(client, server.rules).catch((e) => e);
      await settled();
      server.refuse();
      expect(await click).toBeInstanceOf(MailFailure);
      await settled();
      await settled();
      expect(device.reloads).toBe(1);
      expect(device.caches.size).toBe(0);
      expect(device.databases.size).toBe(0);
    } finally {
      restore();
      server.restore();
      client.clear();
    }
  },
);
