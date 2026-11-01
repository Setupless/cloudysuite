import { expect, setSystemTime, test } from "bun:test";
import { createTestDatabase } from "../../../src/db/test-database";
import { ingest, type IngestInput, receiveInbound } from "./ingest";
import {
  createTestEnv,
  eml,
  MAILBOX_A,
  MAILBOX_B,
  toArrayBuffer,
} from "./test-support";
import { MAX_MESSAGE_BYTES, type NewMessage, type ThreadId } from "./types";

const envelope = { from: "a@example.org", to: "b@example.com" };

function inbound(raw: ArrayBuffer, mailboxId = MAILBOX_A): IngestInput {
  return { source: "inbound", mailboxId, raw, envelope };
}

test("a message is stored with its details and raw bytes under its mailbox", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const raw = eml({
    subject: "First",
    messageId: "one@x",
    body: "Hello there.",
  });
  const result = await ingest(env, inbound(raw));
  if (result.status !== "stored") throw new Error("expected stored");

  const thread = instanceOf(MAILBOX_A).object.getThread(result.threadId)!;
  expect(thread.messages[0]).toMatchObject({
    subject: "First",
    rfcMessageId: "one@x",
    from: { address: "alice@example.org", name: "Alice" },
    folder: "inbox",
    source: "inbound",
    envelopeTo: "b@example.com",
    read: false,
    parseStatus: "parsed",
  });
  const keys = bucket.keys();
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatch(
    new RegExp(`^mailboxes/${MAILBOX_A}/messages/[0-9a-f-]{36}/raw\\.eml$`),
  );
  expect(bucket.objects.get(keys[0]!)).toEqual(new Uint8Array(raw));
});

test("delivering the same bytes twice stores one message", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const raw = eml({ messageId: "one@x" });
  const first = await ingest(env, inbound(raw));
  bucket.failPutsMatching = /./;
  const second = await ingest(env, inbound(raw));
  expect(first.status).toBe("stored");
  expect(second.status).toBe("duplicate");
  const { db } = instanceOf(MAILBOX_A);
  expect(db.exec("SELECT id FROM messages").toArray()).toHaveLength(1);
});

// Each loser's cleanup comes due from the moment its commit lands, and one alarm
// removes only what is due by then, so a gap between commits means another alarm.
test.each([
  { commits: "in the same millisecond", gapMs: 0, keysAfterEachAlarm: [1] },
  { commits: "a millisecond apart", gapMs: 1, keysAfterEachAlarm: [2, 1] },
])(
  "deliveries that overlap store one message and keep one set of objects, with commits $commits",
  async ({ gapMs, keysAfterEachAlarm }) => {
    const { env, bucket, instanceOf } = createTestEnv();
    const { object, db } = instanceOf(MAILBOX_A);
    const findByHash = object.findByHash.bind(object);
    let arrived = 0;
    let allArrived!: () => void;
    const everyoneChecked = new Promise<void>((resolve) => {
      allArrived = resolve;
    });
    object.findByHash = (async (rawHash: string) => {
      const found = findByHash(rawHash);
      arrived += 1;
      if (arrived === 3) allArrived();
      await everyoneChecked;
      return found;
    }) as never;

    const commit = object.commit.bind(object);
    let clock = Date.parse("2026-11-02T10:00:00Z");
    object.commit = ((message: NewMessage) => {
      setSystemTime(new Date(clock));
      clock += gapMs;
      return commit(message);
    }) as never;

    try {
      const raw = eml({ messageId: "one@x" });
      const results = await Promise.all([
        ingest(env, inbound(raw)),
        ingest(env, inbound(raw)),
        ingest(env, inbound(raw)),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "duplicate",
        "duplicate",
        "stored",
      ]);
      expect(db.exec("SELECT id FROM messages").toArray()).toHaveLength(1);
      expect(bucket.keys()).toHaveLength(3);

      const [winner] = db
        .exec<{ r2_prefix: string }>("SELECT r2_prefix FROM messages")
        .toArray();
      const winnerKey = `${winner!.r2_prefix}raw.eml`;
      for (const keys of keysAfterEachAlarm) {
        expect(instanceOf(MAILBOX_A).alarm).not.toBeNull();
        await instanceOf(MAILBOX_A).fireAlarm();
        expect(bucket.keys()).toHaveLength(keys);
        expect(bucket.objects.get(winnerKey)).toEqual(new Uint8Array(raw));
      }
      expect(instanceOf(MAILBOX_A).alarm).toBeNull();
    } finally {
      setSystemTime();
    }
  },
);

test("the same message in two mailboxes is stored separately in each", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const raw = eml({ messageId: "one@x" });
  await ingest(env, inbound(raw, MAILBOX_A));
  await ingest(env, inbound(raw, MAILBOX_B));
  expect(bucket.keys(`mailboxes/${MAILBOX_A}/`)).toHaveLength(1);
  expect(bucket.keys(`mailboxes/${MAILBOX_B}/`)).toHaveLength(1);
  for (const id of [MAILBOX_A, MAILBOX_B]) {
    const { db } = instanceOf(id);
    expect(db.exec("SELECT id FROM messages").toArray()).toHaveLength(1);
  }
});

test("a forged reference cannot pull in a thread from another mailbox", async () => {
  const { env, instanceOf } = createTestEnv();
  await ingest(
    env,
    inbound(eml({ messageId: "secret@x", subject: "Private" })),
  );
  const forged = await ingest(
    env,
    inbound(eml({ messageId: "evil@x", references: "<secret@x>" }), MAILBOX_B),
  );
  if (forged.status !== "stored") throw new Error("expected stored");
  const thread = instanceOf(MAILBOX_B).object.getThread(forged.threadId)!;
  expect(thread.messages.map((m) => m.rfcMessageId)).toEqual(["evil@x"]);
});

const withAttachment = toArrayBuffer(
  [
    "From: a@example.org",
    "Subject: With file",
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

test("a failed write leaves no objects behind once swept, and a retry stores the message", async () => {
  for (const failing of [/raw\.eml$/, /attachments\/0$/]) {
    const { env, bucket, instanceOf } = createTestEnv();
    bucket.failPutsMatching = failing;
    await expect(ingest(env, inbound(withAttachment))).rejects.toThrow(
      "R2 is unavailable",
    );
    const { db, object } = instanceOf(MAILBOX_A);
    expect(db.exec("SELECT id FROM messages").toArray()).toEqual([]);
    expect(instanceOf(MAILBOX_A).alarm).not.toBeNull();

    bucket.failPutsMatching = null;
    const retry = await ingest(env, inbound(withAttachment));
    expect(retry.status).toBe("stored");
    await instanceOf(MAILBOX_A).fireAlarm();
    expect(bucket.keys()).toHaveLength(2);
    expect(db.exec("SELECT id FROM attachments").toArray()).toHaveLength(1);
    expect(db.exec("SELECT prefix FROM r2_deletions").toArray()).toEqual([]);
  }
});

test("a crash just before the commit leaves its objects, and a retry stores its own", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const { object, db } = instanceOf(MAILBOX_A);
  const commit = object.commit.bind(object);
  object.commit = () => {
    throw new Error("the Worker stopped here");
  };
  await expect(ingest(env, inbound(withAttachment))).rejects.toThrow();
  const objectsAfterCrash = bucket.keys();
  expect(objectsAfterCrash).toHaveLength(2);
  expect(db.exec("SELECT prefix FROM r2_deletions").toArray()).toEqual([]);

  object.commit = commit;
  expect((await ingest(env, inbound(withAttachment))).status).toBe("stored");
  expect(bucket.keys()).toHaveLength(4);
  expect(bucket.keys()).toEqual(expect.arrayContaining(objectsAfterCrash));
});

test("a commit whose reply was lost does not remove the stored message's objects", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const { object } = instanceOf(MAILBOX_A);
  const commit = object.commit.bind(object);
  object.commit = async (message) => {
    await commit(message);
    throw new Error("the reply was lost");
  };
  await expect(ingest(env, inbound(withAttachment))).rejects.toThrow();
  object.commit = commit;

  expect((await ingest(env, inbound(withAttachment))).status).toBe("duplicate");
  await object.alarm();
  expect(bucket.keys()).toHaveLength(2);
});

test("a body over the inline limit goes to R2 and reads back whole", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const body = `findme ${"line of text\n".repeat(200_000)}`;
  const result = await ingest(env, inbound(eml({ body })));
  if (result.status !== "stored") throw new Error("expected stored");

  const { object, db } = instanceOf(MAILBOX_A);
  const refs = object.bodyRefs(result.messageId);
  expect(refs).toEqual([
    { kind: "text", r2Key: expect.stringMatching(/body\.text$/) as string },
  ]);
  expect(bucket.keys().some((key) => key.endsWith("body.text"))).toBe(true);
  expect(
    db
      .exec(
        "SELECT rowid FROM message_search WHERE message_search MATCH 'findme'",
      )
      .toArray(),
  ).toHaveLength(1);
});

test("a message that fails parsing is still stored and shown", async () => {
  const { env, bucket, instanceOf } = createTestEnv();
  const parts = "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n".repeat(600);
  const raw = toArrayBuffer(
    `From: Eve <eve@example.org>\r\nSubject: Bomb\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${parts}`,
  );
  const result = await ingest(env, inbound(raw));
  if (result.status !== "stored") throw new Error("expected stored");

  const { object } = instanceOf(MAILBOX_A);
  const [message] = object.getThread(result.threadId)!.messages;
  expect(message).toMatchObject({
    parseStatus: "failed",
    subject: "Bomb",
    from: { address: "eve@example.org" },
    folder: "inbox",
  });
  expect(message!.snippet).toContain("Content-Type");
  expect(bucket.keys()).toHaveLength(1);
  const [text] = object.bodyRefs(result.messageId);
  expect(text).toMatchObject({ kind: "text" });
});

test("a message over 25 MiB is refused before any work", async () => {
  const { env, bucket } = createTestEnv();
  const raw = new ArrayBuffer(MAX_MESSAGE_BYTES + 1);
  expect(await ingest(env, inbound(raw))).toEqual({ status: "tooLarge" });
  expect(bucket.keys()).toEqual([]);
});

test("imported mail keeps its date, skips the inbox, and records no auth result", async () => {
  const { env, instanceOf } = createTestEnv();
  const raw = eml({
    date: "Tue, 03 Mar 2020 09:00:00 +0000",
    headers: ["Authentication-Results: mx.cloudflare.net; spf=pass"],
  });
  const result = await ingest(env, {
    source: "import",
    mailboxId: MAILBOX_A,
    raw,
  });
  if (result.status !== "stored") throw new Error("expected stored");
  const [message] = instanceOf(MAILBOX_A).object.getThread(
    result.threadId,
  )!.messages;
  expect(message).toMatchObject({
    source: "import",
    folder: "archive",
    read: true,
    receivedAt: Date.UTC(2020, 2, 3, 9),
    sentAt: Date.UTC(2020, 2, 3, 9),
    authResults: null,
    envelopeTo: null,
  });
});

test("an import with a forged future date does not sort above new mail", async () => {
  const { env, instanceOf } = createTestEnv();
  const raw = eml({ date: "Sat, 01 Jan 2100 00:00:00 +0000" });
  const before = Date.now();
  const result = await ingest(env, {
    source: "import",
    mailboxId: MAILBOX_A,
    raw,
  });
  if (result.status !== "stored") throw new Error("expected stored");
  const [message] = instanceOf(MAILBOX_A).object.getThread(
    result.threadId,
  )!.messages;
  expect(message!.receivedAt).toBeLessThanOrEqual(Date.now());
  expect(message!.receivedAt).toBeGreaterThanOrEqual(before);
});

test("only Cloudflare's first Authentication-Results header counts", async () => {
  const { env, instanceOf } = createTestEnv();
  const auth = async (headers: string[], subject: string) => {
    const result = await ingest(env, inbound(eml({ headers, subject })));
    if (result.status !== "stored") throw new Error("expected stored");
    return instanceOf(MAILBOX_A).object.getThread(result.threadId)!.messages[0]!
      .authResults;
  };
  expect(
    await auth(
      [
        "Authentication-Results: mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail",
        "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
      ],
      "a",
    ),
  ).toEqual({ spf: "fail", dkim: "none", dmarc: "fail" });
  expect(
    await auth(
      [
        "Authentication-Results: evil.example; spf=pass",
        "Authentication-Results: mx.cloudflare.net; spf=pass",
      ],
      "b",
    ),
  ).toBeNull();
  expect(await auth([], "c")).toBeNull();
});

test("restarting the Durable Object keeps its data and applies nothing again", async () => {
  const { env, instanceOf, restart } = createTestEnv();
  const result = await ingest(env, inbound(eml({ messageId: "one@x" })));
  if (result.status !== "stored") throw new Error("expected stored");
  const { db } = instanceOf(MAILBOX_A);
  const before = db.exec("SELECT * FROM schema_migrations").toArray();
  restart(MAILBOX_A);
  restart(MAILBOX_A);
  expect(db.exec("SELECT * FROM schema_migrations").toArray()).toEqual(before);
  expect(
    instanceOf(MAILBOX_A).object.getThread(result.threadId as ThreadId),
  ).not.toBeNull();
});

function inboundEvent(to: string, raw: ArrayBuffer, rawSize = raw.byteLength) {
  const rejections: string[] = [];
  return {
    rejections,
    event: {
      from: "a@example.org",
      to,
      rawSize,
      raw: new Response(raw).body!,
      setReject: (reason: string) => rejections.push(reason),
    } as unknown as ForwardableEmailMessage,
  };
}

function directory() {
  const { sqlite, d1 } = createTestDatabase();
  sqlite.run(
    "INSERT INTO domains (name, is_primary) VALUES ('example.com', 1)",
  );
  sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'personal', 'Bob')",
    [MAILBOX_A],
  );
  sqlite.run(
    "INSERT INTO addresses (address, domain, mailbox_id, kind) VALUES ('bob@example.com', 'example.com', ?, 'primary')",
    [MAILBOX_A],
  );
  return { sqlite, d1 };
}

test("mail for an unknown address is rejected with a plain reason and stores nothing", async () => {
  const { d1 } = directory();
  const { env, bucket } = createTestEnv(d1);
  const { event, rejections } = inboundEvent("nobody@example.com", eml({}));
  await receiveInbound(event, env);
  expect(rejections).toEqual(["There is no mailbox at this address."]);
  expect(bucket.keys()).toEqual([]);
});

test("a plus address in any case reaches the mailbox and records the address used", async () => {
  const { d1 } = directory();
  const { env, instanceOf } = createTestEnv(d1);
  const { event, rejections } = inboundEvent(
    "BOB+news@Example.com",
    eml({ subject: "Plus" }),
  );
  await receiveInbound(event, env);
  expect(rejections).toEqual([]);
  const [message] = instanceOf(MAILBOX_A).object.listThreads({
    view: { folder: "inbox" },
  }).threads;
  expect(message?.subject).toBe("Plus");
});

test("a declared size over the limit is rejected without reading the message", async () => {
  const { d1 } = directory();
  const { env, bucket } = createTestEnv(d1);
  const { event, rejections } = inboundEvent(
    "bob@example.com",
    eml({}),
    MAX_MESSAGE_BYTES + 1,
  );
  await receiveInbound(event, env);
  expect(rejections).toEqual(["This message is larger than the 25 MB limit."]);
  expect(bucket.keys()).toEqual([]);
});

test("mail still arrives when Mail is turned off", async () => {
  const { sqlite, d1 } = directory();
  sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
  const { env, instanceOf } = createTestEnv(d1);
  const { event, rejections } = inboundEvent("bob@example.com", eml({}));
  await receiveInbound(event, env);
  expect(rejections).toEqual([]);
  expect(
    instanceOf(MAILBOX_A).object.listThreads({ view: { folder: "inbox" } })
      .threads,
  ).toHaveLength(1);
});
