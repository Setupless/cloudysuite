import { beforeEach, expect, test } from "bun:test";
import { testWorkerEnv } from "../../../src/db/test-database";
import { createTestEnv, MAILBOX_A } from "./test-support";
import { createKit, type Kit, signIn } from "../../auth/src/admin/test-kit";

const { downloadAttachment } = await import("./download");

let kit: Kit;
let request: Request;

beforeEach(async () => {
  kit = await createKit();
  Object.assign(testWorkerEnv, createTestEnv(kit.database).env, {
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  });
  kit.sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'personal', 'Boss')",
    [MAILBOX_A],
  );
  const signedIn = await signIn(kit, "boss@example.com");
  request = new Request(`https://mail.example.com/download/${MAILBOX_A}/1/1`, {
    headers: { cookie: signedIn.headers.get("set-cookie") ?? "" },
  });
});

const download = () =>
  downloadAttachment(request, {
    mailboxId: MAILBOX_A,
    messageId: "1",
    attachmentId: "1",
  });

test("a download refused for lost access shows plain words, not code", async () => {
  const refused = await download();
  expect(refused.status).toBe(403);
  expect(refused.headers.get("Content-Type")).toStartWith("text/plain");
  expect(await refused.text()).toContain(
    "You don't have access to this mailbox",
  );
});

test("a download refused because Mail is off keeps the mark that says so", async () => {
  kit.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
  const refused = await download();
  expect(refused.status).toBe(403);
  expect(refused.headers.get("CloudySuite-App-Off")).toBe("mail");
  expect(await refused.text()).toContain("turned Mail off");
});
