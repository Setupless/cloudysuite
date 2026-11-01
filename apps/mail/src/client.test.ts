import { expect, test } from "bun:test";
import { checkMailboxAccess, type MailboxGrant } from "@cloudysuite/access";
import type { MailboxId, UserId } from "../../../src/db/schema";
import { createTestDatabase } from "../../../src/db/test-database";
import { openMailbox } from "./client";
import { ingest } from "./ingest";
import {
  createTestEnv,
  eml,
  MAILBOX_A,
  MAILBOX_B,
  toArrayBuffer,
} from "./test-support";

const alice = "user-alice" as UserId;

async function grantFor(mailboxId: MailboxId): Promise<MailboxGrant> {
  const { sqlite, d1 } = createTestDatabase();
  sqlite.run(
    "INSERT INTO user (id, name, email) VALUES (?, 'Alice', 'a@x.org')",
    [alice],
  );
  sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'shared', 'x')",
    [mailboxId],
  );
  sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'member')",
    [mailboxId, alice],
  );
  const access = await checkMailboxAccess(d1, alice, mailboxId);
  if (!access.allowed) throw new Error("expected access");
  return access.grant;
}

const inbound = (raw: ArrayBuffer, mailboxId = MAILBOX_A) =>
  ({
    source: "inbound",
    mailboxId,
    raw,
    envelope: { from: "a@x.org", to: "b@x.org" },
  }) as const;

async function stored(result: ReturnType<typeof ingest>) {
  const done = await result;
  if (done.status !== "stored") throw new Error("expected stored");
  return done;
}

test("a grant opens only its own mailbox", async () => {
  const { env } = createTestEnv();
  await ingest(env, inbound(eml({ subject: "In A" }), MAILBOX_A));
  await ingest(env, inbound(eml({ subject: "In B" }), MAILBOX_B));
  const mailbox = openMailbox(env, await grantFor(MAILBOX_A));
  const page = await mailbox.listThreads({ view: { folder: "inbox" } });
  expect(page.threads.map((thread) => thread.subject)).toEqual(["In A"]);
});

test("code cannot open a mailbox with a bare id or a lookalike grant", () => {
  const { env } = createTestEnv();
  // @ts-expect-error A mailbox id is not a grant.
  const openedById = () => openMailbox(env, MAILBOX_A);
  // @ts-expect-error Only the access check issues a grant.
  const lookalike = () => openMailbox(env, { mailboxId: MAILBOX_A });
  expect(openedById).toBeFunction();
  expect(lookalike).toBeFunction();
});

test("the client offers no way to add mail or reach the raw stub", async () => {
  const { env } = createTestEnv();
  const mailbox = openMailbox(env, await grantFor(MAILBOX_A));
  expect(Object.keys(mailbox).sort()).toEqual([
    "deleteForever",
    "getAttachment",
    "getBody",
    "getRaw",
    "getThread",
    "listThreads",
    "moveToFolder",
    "moveToTrash",
    "setFlags",
  ]);
});

test("bodies read back whether stored inline or in R2", async () => {
  const { env } = createTestEnv();
  const mailbox = openMailbox(env, await grantFor(MAILBOX_A));
  const small = await stored(ingest(env, inbound(eml({ body: "small body" }))));
  const longBody = "x".repeat(2_500_000);
  const big = await stored(
    ingest(env, inbound(eml({ body: longBody, subject: "Big" }))),
  );
  expect((await mailbox.getBody(small.messageId))?.text?.trim()).toBe(
    "small body",
  );
  expect((await mailbox.getBody(big.messageId))?.text?.trim()).toBe(longBody);
  expect(await mailbox.getBody(999 as never)).toBeNull();
});

test("an attachment and the original message read back, within their message only", async () => {
  const { env } = createTestEnv();
  const mailbox = openMailbox(env, await grantFor(MAILBOX_A));
  const raw = toArrayBuffer(
    [
      "From: a@example.org",
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--b",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "AAEC",
      "--b--",
    ].join("\r\n"),
  );
  const result = await stored(ingest(env, inbound(raw)));
  const other = await stored(ingest(env, inbound(eml({ subject: "Other" }))));
  const thread = await mailbox.getThread(result.threadId);
  const info = thread!.messages[0]!.attachments[0]!;
  expect(info).toMatchObject({
    filename: "report.pdf",
    mimeType: "application/pdf",
    size: 3,
    inline: false,
  });

  const download = await mailbox.getAttachment(result.messageId, info.id);
  expect(download?.info).toEqual(info);
  expect(
    new Uint8Array(await new Response(download!.body).arrayBuffer()),
  ).toEqual(new Uint8Array([0, 1, 2]));
  expect(await mailbox.getAttachment(other.messageId, info.id)).toBeNull();

  const original = await mailbox.getRaw(result.messageId);
  expect(new Uint8Array(await new Response(original).arrayBuffer())).toEqual(
    new Uint8Array(raw),
  );
  expect(await mailbox.getRaw(999 as never)).toBeNull();
});

test("trash, then delete for good, removes every object and can repeat", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const mailbox = openMailbox(env, await grantFor(MAILBOX_A));
  const result = await stored(
    ingest(env, inbound(eml({ body: "y".repeat(1_500_000) }))),
  );
  expect(bucket.keys()).toHaveLength(2);

  const selection = { messageIds: [result.messageId] };
  expect(await mailbox.deleteForever(selection)).toBe(0);
  expect(bucket.keys()).toHaveLength(2);

  expect(await mailbox.moveToTrash(selection)).toBe(1);
  const trash = await mailbox.listThreads({ view: { folder: "trash" } });
  expect(trash.threads.map((thread) => thread.id)).toEqual([result.threadId]);

  bucket.failDeletes = true;
  expect(await mailbox.deleteForever(selection)).toBe(1);
  expect(await mailbox.getThread(result.threadId)).toBeNull();
  expect(bucket.keys()).toHaveLength(2);
  expect(instanceOf(MAILBOX_A).alarm).not.toBeNull();

  bucket.failDeletes = false;
  await instanceOf(MAILBOX_A).object.alarm();
  expect(bucket.keys()).toEqual([]);
  expect(instanceOf(MAILBOX_A).alarm).toBeNull();

  expect(await mailbox.deleteForever(selection)).toBe(0);
  expect(instanceOf(MAILBOX_A).alarm).toBeNull();
});
