import { beforeEach, expect, mock, test } from "bun:test";
import { testWorkerEnv } from "../../../src/db/test-database";
import { createKit, type Kit, signIn } from "../../auth/src/admin/test-kit";

const workers = {
  env: testWorkerEnv as unknown as Record<string, unknown>,
  DurableObject: class {},
};
mock.module("cloudflare:workers", () => workers);
const { requireStorageUser } = await import("./access");

let kit: Kit;
let cookie: string;

beforeEach(async () => {
  kit = await createKit();
  workers.env.DB = kit.database;
  workers.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
  cookie = (await signIn(kit, "boss@example.com")).headers.get("set-cookie")!;
});

const fromMail = () =>
  new Request("https://mail.example.com/_serverFn/x", {
    method: "POST",
    headers: { cookie },
  });

test("with Storage off, a call through another app's address is refused in plain words", async () => {
  expect((await requireStorageUser(fromMail())).id).toBe(kit.admin);

  kit.sqlite.run(
    "INSERT INTO app_settings (app, enabled) VALUES ('storage', 0)",
  );
  const refused = await requireStorageUser(fromMail()).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(refused).toBeInstanceOf(Response);
  expect((refused as Response).status).toBe(403);
  expect(
    ((await (refused as Response).json()) as { message: string }).message,
  ).toContain("turned Storage off");
});
