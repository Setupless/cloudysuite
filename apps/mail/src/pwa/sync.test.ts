import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { UserId } from "@cloudysuite/access";
import { testWorkerEnv } from "../../../../src/db/test-database";
import { createKit, type Kit, signIn } from "../../../auth/src/admin/test-kit";
import { createTestEnv, MAILBOX_A } from "../test-support";
import type { MailboxId } from "../types";
import { emptyLedger } from "./offline-model";

// IndexedDB isn't in Bun, so this stands in for what the device holds, by mailbox.
const device = new Map<MailboxId, string>();
mock.module("./device-store", () => ({
  saveMailboxes: async () => true,
  savedMailboxIds: async () => [...device.keys()],
  saveLists: async () => true,
  readLedger: async () => emptyLedger(),
  forgetThreads: async () => true,
  saveBatch: async () => true,
  forgetMailbox: async (_user: UserId, mailboxId: MailboxId) => {
    device.delete(mailboxId);
    return true;
  },
  clearDevice: async () => device.clear(),
}));

const { openMailboxFor } = await import("../access");

let kit: Kit;
let browser: Request;
let whileSyncing: () => void;

// The server's answers, with its real refusals: each mailbox call goes through the
// same check as a Mail server function.
mock.module("../functions", () => ({
  listMailboxes: async () => {
    whileSyncing();
    return [{ id: MAILBOX_A }];
  },
  listThreads: async ({ data }: { data: { mailboxId: MailboxId } }) => {
    await openMailboxFor(browser, data.mailboxId);
    return { threads: [], nextCursor: null };
  },
}));
mock.module("./functions", () => ({
  getSavedThreadBatch: async () => ({ threads: [], bodies: [] }),
}));

const { saveMailForOffline } = await import("./sync");

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
  browser = new Request("https://mail.example.com/_serverFn/x", {
    headers: { cookie: signedIn.headers.get("set-cookie") ?? "" },
  });
  device.clear();
  device.set(MAILBOX_A, "saved before");
});

test("saved mail survives Mail being turned off while the device syncs", async () => {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  whileSyncing = () =>
    kit.sqlite.run(
      "INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)",
    );

  await saveMailForOffline(kit.admin);
  quiet.mockRestore();

  expect(device.get(MAILBOX_A)).toBe("saved before");
});

test("a mailbox this person loses while the device syncs is forgotten", async () => {
  whileSyncing = () => kit.sqlite.run("DELETE FROM mailbox_access");

  await saveMailForOffline(kit.admin);

  expect(device.has(MAILBOX_A)).toBe(false);
});
