import { beforeEach, expect, mock, test } from "bun:test";
import { testWorkerEnv } from "../../../src/db/test-database";
import { AUTH_ORIGIN, createKit, type Kit, signIn } from "./admin/test-kit";

const workers = {
  env: testWorkerEnv as unknown as Record<string, unknown>,
  DurableObject: class {},
};
mock.module("cloudflare:workers", () => workers);
const { requireReadyUser, requireSignedInUser } = await import("./guard");

let kit: Kit;
let cookie: string;

beforeEach(async () => {
  kit = await createKit();
  workers.env.DB = kit.database;
  workers.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
  cookie = (await signIn(kit, "boss@example.com")).headers.get("set-cookie")!;
});

const call = () =>
  new Request("https://mail.example.com/_serverFn/x", {
    method: "POST",
    headers: { cookie },
  });

async function statusOf(run: Promise<unknown>) {
  const refused = await run.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(refused instanceof Response)) throw refused ?? new Error("Allowed");
  return refused.status;
}

test("the 2FA rule applies from the next call after an admin turns it on", async () => {
  expect((await requireReadyUser(call())).id).toBe(kit.admin);

  kit.sqlite.run("INSERT INTO org_settings (id, require_2fa) VALUES (1, 1)");
  expect(await statusOf(requireReadyUser(call()))).toBe(403);
  expect((await requireSignedInUser(call())).id).toBe(kit.admin);
});

test("a call after signing out is refused", async () => {
  expect((await requireReadyUser(call())).id).toBe(kit.admin);

  const signedOut = await kit.auth.handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin: AUTH_ORIGIN },
    }),
  );
  expect(signedOut.status).toBe(200);
  expect(await statusOf(requireReadyUser(call()))).toBe(401);
});
