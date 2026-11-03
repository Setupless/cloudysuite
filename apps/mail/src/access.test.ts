import { beforeEach, expect, test } from "bun:test";
import { testWorkerEnv } from "../../../src/db/test-database";
import { createTestEnv, MAILBOX_A } from "./test-support";
import { createKit, type Kit, signIn } from "../../auth/src/admin/test-kit";

const { openMailboxFor } = await import("./access");

let kit: Kit;
let fromStorage: Request;

beforeEach(async () => {
  kit = await createKit();
  Object.assign(testWorkerEnv, createTestEnv(kit.database).env, {
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  });
  kit.sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'personal', 'Boss')",
    [MAILBOX_A],
  );
  kit.sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'manager')",
    [MAILBOX_A, kit.admin],
  );
  const signedIn = await signIn(kit, "boss@example.com");
  fromStorage = new Request("https://storage.example.com/_serverFn/x", {
    method: "POST",
    headers: { cookie: signedIn.headers.get("set-cookie") ?? "" },
  });
});

test("with Mail off, a call through another app's address is refused in plain words", async () => {
  const mailbox = await openMailboxFor(fromStorage, MAILBOX_A);
  expect(await mailbox.summary()).toMatchObject({ labels: [] });

  kit.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
  const refused = await openMailboxFor(fromStorage, MAILBOX_A).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(refused).toBeInstanceOf(Response);
  expect((refused as Response).status).toBe(403);
  expect(
    ((await (refused as Response).json()) as { message: string }).message,
  ).toContain("turned Mail off");
});
