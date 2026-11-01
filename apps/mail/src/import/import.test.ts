import { expect, test } from "bun:test";
import { checkMailboxAccess, type MailboxGrant } from "@cloudysuite/access";
import type { MailboxRole, UserId } from "../../../../src/db/schema";
import { createTestDatabase } from "../../../../src/db/test-database";
import { openMailbox, openMailboxImports } from "../client";
import { ingest } from "../ingest";
import { createTestEnv, eml, MAILBOX_A } from "../test-support";
import type { MessageDetail, ThreadId } from "../types";
import { BATCH_LIMITS } from "./job";
import { type MailboxImports, readUpTo } from "./uploads";
import { type ImportJobView, MAX_FILE_BYTES, PART_BYTES } from "./types";

const alice = "user-alice" as UserId;
const encoder = new TextEncoder();
const FILE = { fileName: "All mail.mbox", fingerprint: "abc" };

async function grantWith(role: MailboxRole): Promise<MailboxGrant> {
  const { sqlite, d1 } = createTestDatabase();
  sqlite.run("INSERT INTO user (id, name, email) VALUES (?, 'A', 'a@x.org')", [
    alice,
  ]);
  sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'shared', 'x')",
    [MAILBOX_A],
  );
  sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, ?)",
    [MAILBOX_A, alice, role],
  );
  const access = await checkMailboxAccess(d1, alice, MAILBOX_A);
  if (!access.allowed) throw new Error("expected access");
  return access.grant;
}

type Harness = ReturnType<typeof createTestEnv> & {
  imports: MailboxImports;
  grant: MailboxGrant;
};

async function harness(): Promise<Harness> {
  const test = createTestEnv();
  const grant = await grantWith("manager");
  return { ...test, grant, imports: openMailboxImports(test.env, grant)! };
}

function mustOk<Value>(
  outcome: { ok: true; value: Value } | { ok: false; message: string },
): Value {
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.value;
}

const streamOf = (bytes: Uint8Array) =>
  new Response(bytes.slice()).body as ReadableStream<Uint8Array>;

const partBody = (bytes: Uint8Array) => ({
  declaredBytes: bytes.byteLength,
  read: (limit: number) => readUpTo(streamOf(bytes), limit),
});

async function upload(h: Harness, bytes: Uint8Array): Promise<ImportJobView> {
  const job = mustOk(await h.imports.start({ ...FILE, size: bytes.length }));
  for (let part = 1; part <= job.partCount; part += 1) {
    const start = (part - 1) * PART_BYTES;
    mustOk(
      await h.imports.putPart(
        job.id,
        part,
        partBody(bytes.subarray(start, start + PART_BYTES)),
      ),
    );
  }
  return mustOk(await h.imports.finishUpload(job.id));
}

async function finishImport(h: Harness, maxAlarms = 1000) {
  const instance = h.instanceOf(MAILBOX_A);
  for (let i = 0; i < maxAlarms; i += 1) {
    const { jobs } = await h.imports.status();
    if (jobs[0]?.state !== "queued" && jobs[0]?.state !== "running") return;
    await instance.fireAlarm();
  }
  throw new Error("the import did not finish");
}

function mboxOf(count: number, firstId = 0): string {
  let file = "";
  for (let i = firstId; i < firstId + count; i += 1) {
    const day = String((i % 28) + 1).padStart(2, "0");
    file += `From sender@example.org Thu Jan ${day} 10:00:00 2015\n`;
    file += `From: Sender ${i} <sender@example.org>\nTo: me@example.com\n`;
    file += `Subject: Message number ${i}\nDate: Thu, ${day} Jan 2015 10:00:00 +0000\n`;
    file += `Message-ID: <m${i}@example.org>\n`;
    if (i % 10 !== 0) {
      file += `In-Reply-To: <m${i - (i % 10)}@example.org>\n`;
    }
    file += `\nBody word${i}\n>From a quoted line\n\n`;
  }
  return file;
}

const countRows = (h: Harness, table: string) =>
  h
    .instanceOf(MAILBOX_A)
    .db.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
    .toArray()[0]!.n;

async function allMessages(h: Harness): Promise<MessageDetail[]> {
  const mailbox = openMailbox(h.env, h.grant);
  const messages: MessageDetail[] = [];
  let cursor: string | undefined;
  do {
    const page = await mailbox.listThreads({
      view: { folder: "archive" },
      limit: 100,
      cursor,
    });
    for (const thread of page.threads) {
      const detail = await mailbox.getThread(thread.id as ThreadId);
      messages.push(...detail!.messages);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return messages;
}

type Instance = ReturnType<Harness["instanceOf"]>;

const stopCommits = ({ sqlite }: Instance) =>
  sqlite.run(
    "CREATE TRIGGER stop_commits BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'the Durable Object stopped here'); END",
  );

const allowCommits = ({ sqlite }: Instance) =>
  sqlite.run("DROP TRIGGER stop_commits");

// Runs every alarm until no background work remains, however far off it is.
async function settle(h: Harness) {
  const instance = h.instanceOf(MAILBOX_A);
  for (let i = 0; i < 20 && instance.alarm !== null; i += 1) {
    await instance.fireAlarm();
  }
}

test("a file goes from upload to messages in Archive, read, with original dates and threads", async () => {
  const h = await harness();
  const count = BATCH_LIMITS.items * 3 + 7;
  const job = await upload(h, encoder.encode(mboxOf(count)));
  expect(job.state).toBe("queued");
  await finishImport(h);

  const { jobs } = await h.imports.status();
  expect(jobs[0]).toMatchObject({
    state: "done",
    stored: count,
    duplicates: 0,
    unreadable: 0,
  });
  const messages = await allMessages(h);
  expect(messages).toHaveLength(count);
  for (const message of messages) {
    expect(message).toMatchObject({
      folder: "archive",
      read: true,
      source: "import",
    });
    expect(new Date(message.receivedAt).getUTCFullYear()).toBe(2015);
  }
  const threads = new Set(messages.map((message) => message.threadId));
  expect(threads.size).toBe(Math.ceil(count / 10));
  const hits = h
    .instanceOf(MAILBOX_A)
    .db.exec(
      "SELECT rowid FROM message_search WHERE message_search MATCH 'word42'",
    )
    .toArray();
  expect(hits).toHaveLength(1);
});

test("imported mail does not run through triage, so it never reaches the inbox", async () => {
  const h = await harness();
  await upload(h, encoder.encode(mboxOf(3)));
  await finishImport(h);
  const inbox = await openMailbox(h.env, h.grant).listThreads({
    view: { folder: "inbox" },
  });
  expect(inbox.threads).toEqual([]);
});

test("a message with no Date header takes the date from its separator line", async () => {
  const h = await harness();
  await upload(
    h,
    encoder.encode(
      "From a@example.org Fri Mar 05 08:00:00 +0000 2010\nSubject: Old\nMessage-ID: <old@x>\n\nHi\n",
    ),
  );
  await finishImport(h);
  const [message] = await allMessages(h);
  expect(message?.receivedAt).toBe(Date.UTC(2010, 2, 5, 8));
});

test("importing the same file twice adds nothing", async () => {
  const h = await harness();
  const file = encoder.encode(mboxOf(60));
  await upload(h, file);
  await finishImport(h);
  const objects = h.bucket
    .keys("mailboxes/")
    .filter((k) => k.includes("/messages/"));

  await upload(h, file);
  await finishImport(h);
  const { jobs } = await h.imports.status();
  expect(jobs[0]).toMatchObject({ state: "done", stored: 0, duplicates: 60 });
  expect(countRows(h, "messages")).toBe(60);
  expect(
    h.bucket.keys("mailboxes/").filter((k) => k.includes("/messages/")),
  ).toEqual(objects);
});

test("a message that arrived by mail is not imported again", async () => {
  const h = await harness();
  const raw = eml({ messageId: "same@x", body: "Hello.\r\n" });
  await ingest(h.env, {
    source: "inbound",
    mailboxId: MAILBOX_A,
    raw,
    envelope: { from: "a@x.org", to: "b@x.org" },
  });
  const text = new TextDecoder().decode(raw);
  await upload(
    h,
    encoder.encode(`From a@x Mon Nov  2 10:00:00 2026\n${text}\n`),
  );
  await finishImport(h);
  expect((await h.imports.status()).jobs[0]).toMatchObject({
    state: "done",
    stored: 0,
    duplicates: 1,
  });
});

test("a batch that dies resumes from the saved offset with no duplicates or lost mail", async () => {
  const h = await harness();
  const count = BATCH_LIMITS.items * 2 + 5;
  await upload(h, encoder.encode(mboxOf(count)));
  const instance = h.instanceOf(MAILBOX_A);

  await instance.fireAlarm();
  const before = (await h.imports.status()).jobs[0]!;
  expect(before.stored).toBe(BATCH_LIMITS.items);

  // R2 writes succeed and then the transaction that saves them throws.
  stopCommits(instance);
  await instance.fireAlarm();
  allowCommits(instance);
  h.restart(MAILBOX_A);

  const stuck = (await h.imports.status()).jobs[0]!;
  expect(stuck.byteOffset).toBe(before.byteOffset);
  expect(stuck.stored).toBe(BATCH_LIMITS.items);
  const orphans = h.bucket.keys().filter((k) => k.endsWith("raw.eml")).length;
  expect(orphans).toBe(BATCH_LIMITS.items * 2);

  await finishImport(h);
  expect((await h.imports.status()).jobs[0]).toMatchObject({
    state: "done",
    stored: count,
    duplicates: 0,
  });
  expect(countRows(h, "messages")).toBe(count);

  // The dead batch's objects are swept once the settling delay has passed.
  await settle(h);
  expect(h.bucket.keys().filter((k) => k.endsWith("raw.eml"))).toHaveLength(
    count,
  );
});

test("a batch that keeps dying narrows to one message, then lists it and moves on", async () => {
  const h = await harness();
  await upload(h, encoder.encode(mboxOf(3)));
  const instance = h.instanceOf(MAILBOX_A);
  stopCommits(instance);
  for (let death = 0; death < 4; death += 1) await instance.fireAlarm();
  allowCommits(instance);
  await finishImport(h);
  const status = await h.imports.status();
  expect(status.jobs[0]).toMatchObject({
    state: "done",
    stored: 2,
    unreadable: 1,
  });
  expect(status.unreadable[0]).toMatchObject({ reason: "couldNotProcess" });
});

test("a storage outage keeps progress and retries without calling mail unreadable", async () => {
  const h = await harness();
  await upload(h, encoder.encode(mboxOf(5)));
  const instance = h.instanceOf(MAILBOX_A);

  h.bucket.failGets = true;
  await instance.fireAlarm();
  await instance.fireAlarm();
  const stalled = (await h.imports.status()).jobs[0]!;
  expect(stalled).toMatchObject({ state: "running", stored: 0, unreadable: 0 });
  expect(instance.alarm).not.toBeNull();

  h.bucket.failGets = false;
  await finishImport(h);
  expect((await h.imports.status()).jobs[0]).toMatchObject({
    state: "done",
    stored: 5,
  });
});

test("a message write that fails keeps the batch so far and tries that message again", async () => {
  const h = await harness();
  await upload(h, encoder.encode(mboxOf(4)));
  const instance = h.instanceOf(MAILBOX_A);
  const put = h.bucket.put.bind(h.bucket);
  let writes = 0;
  h.bucket.put = async (key, value) => {
    writes += 1;
    if (writes === 3) throw new Error("R2 is unavailable");
    return put(key, value);
  };
  await instance.fireAlarm();
  h.bucket.put = put;
  expect((await h.imports.status()).jobs[0]).toMatchObject({
    state: "running",
    stored: 2,
  });
  await finishImport(h);
  expect((await h.imports.status()).jobs[0]).toMatchObject({
    state: "done",
    stored: 4,
    duplicates: 0,
  });
  expect(countRows(h, "messages")).toBe(4);
});

test("a message over the limit is skipped and listed, and the rest arrive", async () => {
  const h = await harness();
  const head = encoder.encode(
    `From a@x Mon Nov  2 10:00:00 2026\nSubject: Too big\nFrom: Bob <bob@x.org>\n\n`,
  );
  const tail = encoder.encode(`\n\n${mboxOf(2)}`);
  const huge = new Uint8Array(head.length + 26 * 1024 * 1024 + tail.length);
  huge.fill(0x70);
  huge.set(head);
  huge.set(tail, huge.length - tail.length);
  await upload(h, huge);
  await finishImport(h);

  const status = await h.imports.status();
  expect(status.jobs[0]).toMatchObject({
    state: "done",
    stored: 2,
    unreadable: 1,
  });
  expect(status.unreadable[0]).toMatchObject({ reason: "tooLarge", offset: 0 });
  expect(status.unreadable[0]?.hint).toContain("Too big");
  expect(countRows(h, "messages")).toBe(2);
});

test("a garbage file fails with a plain reason and leaves no file behind", async () => {
  const h = await harness();
  const job = await upload(h, encoder.encode("not a mailbox at all\n"));
  await finishImport(h);
  const status = await h.imports.status();
  expect(status.jobs[0]).toMatchObject({
    id: job.id,
    state: "failed",
    failure: "notMbox",
    stored: 0,
  });
  await settle(h);
  expect(h.bucket.keys()).toEqual([]);
});

test("the file is removed from storage when a job ends", async () => {
  const h = await harness();
  const job = await upload(h, encoder.encode(mboxOf(2)));
  expect(h.bucket.keys()).toContain(
    `mailboxes/${MAILBOX_A}/imports/${job.id}/file.mbox`,
  );
  await finishImport(h);
  await settle(h);
  expect(h.bucket.keys().filter((k) => k.includes("/imports/"))).toEqual([]);
  expect(h.instanceOf(MAILBOX_A).alarm).toBeNull();
});

test("a member cannot reach imports at all", async () => {
  const { env } = createTestEnv();
  expect(openMailboxImports(env, await grantWith("member"))).toBeNull();
});

test("the file size limits are enforced on the server with a plain message", async () => {
  const h = await harness();
  const tooLarge = await h.imports.start({ ...FILE, size: MAX_FILE_BYTES + 1 });
  expect(tooLarge).toMatchObject({ ok: false, status: 413 });
  expect(
    await h.imports.start({ ...FILE, size: MAX_FILE_BYTES }),
  ).toMatchObject({
    ok: true,
    value: { partCount: 10_000 },
  });
  await h.imports.cancel((await h.imports.status()).jobs[0]!.id);

  expect(await h.imports.start({ ...FILE, size: 0 })).toMatchObject({
    ok: false,
    status: 400,
    message: "This file is empty, so there is nothing to import.",
  });
  expect(await h.imports.start({ ...FILE, size: 1.5 })).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await h.imports.start(null)).toMatchObject({ ok: false, status: 400 });
});

test("a part of the wrong size is refused before it reaches storage", async () => {
  const h = await harness();
  const job = mustOk(
    await h.imports.start({ ...FILE, size: PART_BYTES + 100 }),
  );
  let reads = 0;
  const declared = (declaredBytes: number | null) => ({
    declaredBytes,
    read: async () => {
      reads += 1;
      return new ArrayBuffer(0);
    },
  });
  expect(await h.imports.putPart(job.id, 1, declared(5))).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await h.imports.putPart(job.id, 1, declared(null))).toMatchObject({
    ok: false,
    status: 411,
  });
  expect(reads).toBe(0);

  // A client that declares the right size and sends a different amount.
  const short = await h.imports.putPart(job.id, 2, {
    declaredBytes: 100,
    read: (limit) => readUpTo(streamOf(new Uint8Array(99)), limit),
  });
  expect(short).toMatchObject({ ok: false, status: 400 });
  const long = await h.imports.putPart(job.id, 2, {
    declaredBytes: 100,
    read: (limit) => readUpTo(streamOf(new Uint8Array(101)), limit),
  });
  expect(long).toMatchObject({ ok: false, status: 400 });
  expect(await h.imports.putPart(job.id, 3, declared(100))).toMatchObject({
    ok: false,
    status: 400,
  });
  expect(await h.imports.putPart(job.id, 0, declared(100))).toMatchObject({
    ok: false,
    status: 400,
  });
  expect([...h.bucket.uploads.values()][0]?.parts.size).toBe(0);
});

test("a body is read only up to the size it should have", async () => {
  // Chunks of 4 bytes, so the limit falls inside the last chunk read.
  const chunked = (total: number, onPull: () => void) => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        onPull();
        const size = Math.min(4, total - sent);
        if (size === 0) return controller.close();
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(7));
      },
    });
  };
  let pulls = 0;
  const huge = chunked(1_000_000, () => {
    pulls += 1;
  });
  expect(await readUpTo(huge, 10)).toBeNull();
  expect(pulls).toBeLessThan(10);
  expect(huge.locked).toBe(true);

  expect(
    new Uint8Array(
      (await readUpTo(
        chunked(10, () => {}),
        10,
      ))!,
    ),
  ).toEqual(new Uint8Array(10).fill(7));
  expect(
    (
      await readUpTo(
        chunked(6, () => {}),
        10,
      )
    )?.byteLength,
  ).toBe(6);
  expect((await readUpTo(null, 10))?.byteLength).toBe(0);
});

test("asking again shows which parts arrived, so an upload resumes", async () => {
  const h = await harness();
  const bytes = encoder.encode(mboxOf(4)).slice();
  const large = new Uint8Array(PART_BYTES * 2 + 50);
  large.set(bytes);
  const job = mustOk(await h.imports.start({ ...FILE, size: large.length }));
  mustOk(
    await h.imports.putPart(
      job.id,
      2,
      partBody(large.subarray(PART_BYTES, PART_BYTES * 2)),
    ),
  );

  expect((await h.imports.status()).jobs[0]?.uploadedParts).toEqual([2]);
  expect(await h.imports.finishUpload(job.id)).toMatchObject({
    ok: false,
    status: 409,
  });

  mustOk(
    await h.imports.putPart(job.id, 1, partBody(large.subarray(0, PART_BYTES))),
  );
  mustOk(
    await h.imports.putPart(
      job.id,
      3,
      partBody(large.subarray(PART_BYTES * 2)),
    ),
  );
  // Sending a part again changes nothing.
  mustOk(
    await h.imports.putPart(
      job.id,
      3,
      partBody(large.subarray(PART_BYTES * 2)),
    ),
  );
  const finished = mustOk(await h.imports.finishUpload(job.id));
  expect(finished.state).toBe("queued");
  expect(mustOk(await h.imports.finishUpload(job.id)).state).toBe("queued");
  expect(
    (await h.bucket.head(`mailboxes/${MAILBOX_A}/imports/${job.id}/file.mbox`))
      ?.size,
  ).toBe(large.length);
});

test("finishing again after a crash that followed R2's completion still queues the job", async () => {
  const h = await harness();
  const bytes = encoder.encode(mboxOf(1));
  const job = mustOk(await h.imports.start({ ...FILE, size: bytes.length }));
  mustOk(await h.imports.putPart(job.id, 1, partBody(bytes)));
  const upload = [...h.bucket.uploads.entries()][0]!;
  await h.bucket
    .resumeMultipartUpload(upload[1].key, upload[0])
    .complete([{ partNumber: 1 }]);

  expect(mustOk(await h.imports.finishUpload(job.id)).state).toBe("queued");
});

test("a mailbox runs one import at a time", async () => {
  const h = await harness();
  mustOk(await h.imports.start({ ...FILE, size: 10 }));
  expect(await h.imports.start({ ...FILE, size: 10 })).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(h.bucket.uploads.size).toBe(1);
});

test("cancelling an upload aborts it in R2 and cannot be undone by a late part", async () => {
  const h = await harness();
  const bytes = encoder.encode(mboxOf(1));
  const job = mustOk(await h.imports.start({ ...FILE, size: bytes.length }));
  mustOk(await h.imports.cancel(job.id));
  await h.instanceOf(MAILBOX_A).fireAlarm();
  expect(h.bucket.uploads.size).toBe(0);
  expect((await h.imports.status()).jobs[0]?.state).toBe("cancelled");
  expect(await h.imports.putPart(job.id, 1, partBody(bytes))).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(mustOk(await h.imports.cancel(job.id)).state).toBe("cancelled");
  await settle(h);
  expect(h.instanceOf(MAILBOX_A).alarm).toBeNull();
});

test("cancelling mid-import keeps what was imported and removes the file", async () => {
  const h = await harness();
  const job = await upload(h, encoder.encode(mboxOf(BATCH_LIMITS.items + 5)));
  const instance = h.instanceOf(MAILBOX_A);
  await instance.fireAlarm();
  mustOk(await h.imports.cancel(job.id));
  await settle(h);

  expect((await h.imports.status()).jobs[0]).toMatchObject({
    state: "cancelled",
    stored: BATCH_LIMITS.items,
  });
  expect(countRows(h, "messages")).toBe(BATCH_LIMITS.items);
  expect(h.bucket.keys().filter((k) => k.includes("/imports/"))).toEqual([]);
});

test("cancelling while a batch is writing discards that batch", async () => {
  const h = await harness();
  const job = await upload(h, encoder.encode(mboxOf(5)));
  const instance = h.instanceOf(MAILBOX_A);
  const put = h.bucket.put.bind(h.bucket);
  let cancelled = false;
  h.bucket.put = async (key, value) => {
    if (!cancelled) {
      cancelled = true;
      await h.imports.cancel(job.id);
    }
    return put(key, value);
  };
  await instance.fireAlarm();
  h.bucket.put = put;

  expect((await h.imports.status()).jobs[0]).toMatchObject({
    state: "cancelled",
    stored: 0,
  });
  expect(countRows(h, "messages")).toBe(0);
  await settle(h);
  expect(h.bucket.keys()).toEqual([]);
});

test("an upload left for 3 days is aborted and its parts removed", async () => {
  const h = await harness();
  const bytes = encoder.encode(mboxOf(1));
  const job = mustOk(await h.imports.start({ ...FILE, size: bytes.length }));
  const instance = h.instanceOf(MAILBOX_A);
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  expect(instance.alarm).toBeGreaterThan(Date.now() + threeDays - 60_000);

  await instance.fireAlarm();
  expect(h.bucket.uploads.size).toBe(0);
  expect((await h.imports.status()).jobs[0]).toMatchObject({
    id: job.id,
    state: "failed",
    failure: "abandoned",
  });
});

test("a part arriving pushes back the date an upload counts as abandoned", async () => {
  const h = await harness();
  const bytes = encoder.encode(mboxOf(1));
  const job = mustOk(await h.imports.start({ ...FILE, size: bytes.length }));
  const instance = h.instanceOf(MAILBOX_A);
  const first = instance.alarm!;
  await Bun.sleep(2);
  mustOk(await h.imports.putPart(job.id, 1, partBody(bytes)));
  expect(instance.alarm!).toBeGreaterThan(first);
});

test("an abort that finds the upload already gone counts as done", async () => {
  const h = await harness();
  const bytes = encoder.encode(mboxOf(1));
  const job = mustOk(await h.imports.start({ ...FILE, size: bytes.length }));
  h.bucket.uploads.clear();
  mustOk(await h.imports.cancel(job.id));
  await settle(h);
  expect(h.instanceOf(MAILBOX_A).alarm).toBeNull();
});

test("an abort that keeps failing gives up, so the alarm does not run forever", async () => {
  const h = await harness();
  const bytes = encoder.encode(mboxOf(1));
  const job = mustOk(await h.imports.start({ ...FILE, size: bytes.length }));
  const resume = h.bucket.resumeMultipartUpload.bind(h.bucket);
  h.bucket.resumeMultipartUpload = (key, id) => ({
    ...resume(key, id),
    abort: async () => {
      throw new Error("We encountered an internal error. (10001)");
    },
  });
  mustOk(await h.imports.cancel(job.id));
  const instance = h.instanceOf(MAILBOX_A);
  await instance.fireAlarm();
  expect(instance.alarm).not.toBeNull();
  for (let i = 0; i < 60 && instance.alarm !== null; i += 1) {
    await instance.fireAlarm();
  }
  expect(instance.alarm).toBeNull();
});

test("a part or finish that finds the upload gone from R2 gets a plain refusal", async () => {
  const h = await harness();
  const bytes = encoder.encode(mboxOf(1));
  const job = mustOk(await h.imports.start({ ...FILE, size: bytes.length }));
  mustOk(await h.imports.putPart(job.id, 1, partBody(bytes)));
  h.bucket.uploads.clear();
  expect(await h.imports.putPart(job.id, 1, partBody(bytes))).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(await h.imports.finishUpload(job.id)).toMatchObject({
    ok: false,
    status: 409,
  });
});

test("deleting one imported message leaves the others from its batch", async () => {
  const h = await harness();
  await upload(h, encoder.encode(mboxOf(12)));
  await finishImport(h);
  const mailbox = openMailbox(h.env, h.grant);
  const messages = await allMessages(h);
  const target = messages.find(
    (message) => message.rfcMessageId === "m1@example.org",
  )!;
  await mailbox.moveToTrash({ messageIds: [target.id] });
  expect(await mailbox.deleteForever({ messageIds: [target.id] })).toBe(1);
  await settle(h);
  expect(h.bucket.keys().filter((k) => k.endsWith("raw.eml"))).toHaveLength(11);
  expect(await allMessages(h)).toHaveLength(11);
});

test("the same message twice in one file is stored once and its copy is removed", async () => {
  const h = await harness();
  const one = mboxOf(1);
  await upload(h, encoder.encode(`${one}${one}`));
  await finishImport(h);
  expect((await h.imports.status()).jobs[0]).toMatchObject({
    state: "done",
    stored: 1,
    duplicates: 1,
  });
  await settle(h);
  expect(h.bucket.keys().filter((k) => k.endsWith("raw.eml"))).toHaveLength(1);
});
