import { expect, test } from "bun:test";
import { checkMailboxAccess } from "@cloudysuite/access";
import type { UserId } from "../../../src/db/schema";
import { createTestDatabase } from "../../../src/db/test-database";
import { openMailboxImports } from "./client";
import type { MailboxImports } from "./import/uploads";
import { createTestEnv, MAILBOX_A } from "./test-support";

const FIVE_MINUTES = 5 * 60 * 1000;

async function importsFor(env: Env): Promise<MailboxImports> {
  const { sqlite, d1 } = createTestDatabase();
  const user = "user-a" as UserId;
  sqlite.run("INSERT INTO user (id, name, email) VALUES (?, 'A', 'a@x.org')", [
    user,
  ]);
  sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'shared', 'x')",
    [MAILBOX_A],
  );
  sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'manager')",
    [MAILBOX_A, user],
  );
  const access = await checkMailboxAccess(d1, user, MAILBOX_A);
  if (!access.allowed) throw new Error("expected access");
  return openMailboxImports(env, access.grant)!;
}

function mbox(count: number): Uint8Array {
  let file = "";
  for (let i = 0; i < count; i += 1) {
    file += `From a@x.org Thu Jan 01 10:00:00 2015\nSubject: ${i}\nMessage-ID: <${i}@x>\n\nBody\n\n`;
  }
  return new TextEncoder().encode(file);
}

async function queuedImport(imports: MailboxImports, bytes: Uint8Array) {
  const started = await imports.start({
    fileName: "a.mbox",
    size: bytes.length,
    fingerprint: "f",
  });
  if (!started.ok) throw new Error(started.message);
  await imports.putPart(started.value.id, 1, {
    declaredBytes: bytes.length,
    read: async () => bytes.slice().buffer as ArrayBuffer,
  });
  await imports.finishUpload(started.value.id);
}

test("queueing a deletion during an import keeps the import's earlier wake-up", async () => {
  const { env, instanceOf } = createTestEnv();
  const imports = await importsFor(env);
  await queuedImport(imports, mbox(120));
  const instance = instanceOf(MAILBOX_A);
  await instance.fireAlarm();
  const importDue = instance.alarm!;
  expect(importDue).toBeLessThan(Date.now() + 60_000);

  await instance.object.abandonUpload("orphan/");
  expect(instance.alarm).toBe(importDue);
});

test("an import that keeps rescheduling itself does not starve a sweep that falls due", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const imports = await importsFor(env);
  await bucket.put("orphan/raw.eml", new Uint8Array(1));
  const instance = instanceOf(MAILBOX_A);
  await instance.object.abandonUpload("orphan/");
  const sweepDue = instance.alarm!;

  await queuedImport(imports, mbox(120));
  expect(instance.alarm).toBeLessThan(sweepDue);
  await instance.fireAlarm();
  expect(bucket.keys("orphan/")).toHaveLength(1);

  // The next batch runs late enough that the sweep is due too.
  instance.alarm = sweepDue;
  await instance.fireAlarm();
  expect(bucket.keys("orphan/")).toEqual([]);
  expect((await imports.status()).jobs[0]?.stored).toBe(100);
});

test("a sweep that keeps failing does not hold up an import", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const imports = await importsFor(env);
  const instance = instanceOf(MAILBOX_A);
  await bucket.put("orphan/raw.eml", new Uint8Array(1));
  await instance.object.abandonUpload("orphan/");
  await queuedImport(imports, mbox(3));
  bucket.failDeletes = true;

  instance.alarm = Date.now() + FIVE_MINUTES + 1;
  await instance.fireAlarm();
  expect((await imports.status()).jobs[0]).toMatchObject({
    state: "done",
    stored: 3,
  });
  expect(bucket.keys("orphan/")).toHaveLength(1);
  // The failed sweep still has its own retry in the future.
  expect(instance.alarm).toBeGreaterThan(Date.now());
});

test("an alarm that fires early for an import leaves a settling deletion alone", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const imports = await importsFor(env);
  const instance = instanceOf(MAILBOX_A);
  await bucket.put("orphan/raw.eml", new Uint8Array(1));
  await instance.object.abandonUpload("orphan/");
  const sweepDue = instance.alarm!;
  await queuedImport(imports, mbox(1));

  await instance.fireAlarm();
  expect(bucket.keys("orphan/")).toHaveLength(1);
  expect((await imports.status()).jobs[0]?.state).toBe("done");
  expect(instance.alarm).toBeLessThanOrEqual(sweepDue);
});

test("the alarm clears once no background work remains", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const imports = await importsFor(env);
  await queuedImport(imports, mbox(1));
  const instance = instanceOf(MAILBOX_A);
  for (let i = 0; i < 10 && instance.alarm !== null; i += 1) {
    await instance.fireAlarm();
  }
  expect(
    bucket.keys("mailboxes/").filter((k) => k.includes("/imports/")),
  ).toEqual([]);
  expect(instance.alarm).toBeNull();
});

test("looking at a job whose alarm was lost starts it again", async () => {
  const { env, instanceOf } = createTestEnv();
  const imports = await importsFor(env);
  await queuedImport(imports, mbox(1));
  const instance = instanceOf(MAILBOX_A);
  instance.alarm = null;
  await imports.status();
  expect(instance.alarm).not.toBeNull();
});
