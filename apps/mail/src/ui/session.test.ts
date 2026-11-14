import { beforeAll, expect, mock, test } from "bun:test";
import { isRedirect } from "@tanstack/react-router";
import { testWorkerEnv } from "../../../../src/db/test-database";
import { readRequestFrom } from "../../../../src/test-server-fn";
import { createKit } from "../../../auth/src/admin/test-kit";

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

// Nobody is signed in on this request, and each session check that reads it counts.
const asked = { checks: 0 };
readRequestFrom(() => {
  asked.checks++;
  return new Request("https://mail.example.com/");
});

const { requireMailUser } = await import("./session");

beforeAll(async () => {
  const kit = await createKit();
  Object.assign(testWorkerEnv, {
    DB: kit.database,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  });
});

// What this browser holds for Mail, and what the device-session check answers.
function savedMailDevice({ online = true } = {}) {
  asked.checks = 0;
  const device = {
    sessionReads: 0,
    caches: new Set(["cloudysuite-mail-1"]),
    databases: new Set(["cloudysuite-mail"]),
  };
  const globals: Record<string, unknown> = {
    navigator: { onLine: online },
    fetch: async () => {
      device.sessionReads++;
      return new Response(null, { status: 401 });
    },
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
  const before = Object.fromEntries(
    Object.keys(globals).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  return {
    device,
    restore: () => {
      for (const [name, descriptor] of Object.entries(before)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

const INBOX = { publicHref: "/" };

test("a hover after signing out keeps the saved mail", async () => {
  const { device, restore } = savedMailDevice();
  try {
    const hover = await requireMailUser(INBOX, true).catch((e) => e);
    expect(isRedirect(hover)).toBe(true);
    expect(asked.checks).toBe(1);
    expect(device.sessionReads).toBe(0);
    expect(device.caches.size).toBe(1);
    expect(device.databases.size).toBe(1);
  } finally {
    restore();
  }
});

test("a click after signing out clears the saved mail", async () => {
  const { device, restore } = savedMailDevice();
  try {
    const click = await requireMailUser(INBOX).catch((e) => e);
    expect(isRedirect(click)).toBe(true);
    expect(device.sessionReads).toBe(1);
    expect(device.caches.size).toBe(0);
    expect(device.databases.size).toBe(0);
  } finally {
    restore();
  }
});

test("a hover with no connection asks nothing and keeps the saved mail", async () => {
  const { device, restore } = savedMailDevice({ online: false });
  try {
    const hover = await requireMailUser(INBOX, true).catch((e) => e);
    expect(hover).toBeInstanceOf(Error);
    expect(asked.checks).toBe(0);
    expect(device.sessionReads).toBe(0);
    expect(device.caches.size).toBe(1);
    expect(device.databases.size).toBe(1);
  } finally {
    restore();
  }
});
