import { expect, mock, test } from "bun:test";
import { createTestDatabase, testWorkerEnv } from "./db/test-database";

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
mock.module("@tanstack/react-start/server-entry", () => ({
  default: { fetch: () => new Response("page") },
}));
const { default: worker } = await import("./server");

function workerWith(disabled: string[] = []) {
  const { sqlite, d1 } = createTestDatabase();
  sqlite.run(
    "INSERT INTO domains (name, is_primary) VALUES ('example.com', 1)",
  );
  for (const app of disabled) {
    sqlite.run("INSERT INTO app_settings (app, enabled) VALUES (?, 0)", [app]);
  }
  const env = { DB: d1 } as unknown as Env;
  type IncomingRequest = Parameters<typeof worker.fetch>[0];
  return (url: string, init?: RequestInit) =>
    worker.fetch(new Request(url, init) as IncomingRequest, env);
}

function expectUnframeableAndUnstored(response: Response) {
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "frame-ancestors 'none'",
  );
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

test("a redirect keeps its destination and refuses to be framed", async () => {
  const response = await workerWith(["mail"])("https://mail.example.com/", {
    headers: { "Sec-Fetch-Mode": "navigate" },
  });

  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/off");
  expectUnframeableAndUnstored(response);
});

test("an unknown address says so and refuses to be framed", async () => {
  const response = await workerWith()("https://nothing.example.com/");

  expect(response.status).toBe(404);
  expect(await response.text()).toBe("There is nothing at this address.");
  expectUnframeableAndUnstored(response);
});

test("a call to an app that is off is refused and refuses to be framed", async () => {
  const response = await workerWith(["storage"])(
    "https://storage.example.com/_serverFn/x",
    { method: "POST", body: "{}" },
  );

  expect(response.status).toBe(403);
  expect(((await response.json()) as { message: string }).message).toContain(
    "turned Storage off",
  );
  expectUnframeableAndUnstored(response);
});

test.each([
  [
    "GET",
    "http://auth.example.com/sign-in?returnTo=x",
    "https://auth.example.com/sign-in?returnTo=x",
  ],
  [
    "POST",
    "http://mail.example.com/_serverFn/abc",
    "https://mail.example.com/_serverFn/abc",
  ],
  ["GET", "http://auth.example.com:8080/", "https://auth.example.com/"],
  [
    "GET",
    "http://localhost.attacker.example/",
    "https://localhost.attacker.example/",
  ],
])(
  "%s %s moves to the same address over https",
  async (method, address, secure) => {
    const response = await workerWith()(address, { method });

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(secure);
  },
);

test("an https page is pinned to https", async () => {
  const response = await workerWith()("https://mail.example.com/");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("page");
  expect(response.headers.get("Strict-Transport-Security")).toBe(
    "max-age=31536000",
  );
});

test.each([
  "http://auth.cloudysuite.localhost:8787/",
  "http://localhost:8787/setup",
])("a local dev server at %s is neither moved nor pinned", async (address) => {
  const response = await workerWith()(address);

  expect(response.status).toBe(404);
  expect(response.headers.has("Strict-Transport-Security")).toBe(false);
});
