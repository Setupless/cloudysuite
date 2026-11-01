import { expect, test } from "bun:test";
import type { MailboxId, UserId } from "@cloudysuite/access";
import { createTestDatabase } from "../../../../src/db/test-database";
import { ingest, receiveInbound } from "../ingest";
import { createTestEnv, eml, MAILBOX_A } from "../test-support";
import { FOLDERS, type MessageId } from "../types";
import { MAX_SENDS_PER_RUN, outcomeOf } from "./job";
import { parsePushMessage } from "./notice";
import { announces, PUSH_WINDOW_MS, PushStore } from "./store";
import {
  ensureVapidKeys,
  MAX_DEVICES_PER_PERSON,
  removeSubscription,
  saveSubscription,
} from "./subscriptions";

const ALICE = "user-alice" as UserId;
const BOB = "user-bob" as UserId;

type Sent = { endpoint: string; headers: Headers; body: Uint8Array };

// The push service, as far as the job can tell. Its encryption has its own tests.
function world() {
  const { sqlite, d1 } = createTestDatabase();
  sqlite.run(
    "INSERT INTO domains (name, is_primary) VALUES ('example.com', 1)",
  );
  sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'shared', 'Support')",
    [MAILBOX_A],
  );
  for (const [id, email] of [
    [ALICE, "alice@example.com"],
    [BOB, "bob@example.com"],
  ] as const) {
    sqlite.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
      id,
      id,
      email,
    ]);
    sqlite.run(
      "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'member')",
      [MAILBOX_A, id],
    );
    sqlite.run(
      "INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES (?, ?, ?, ?, 0)",
      [`s-${id}`, `t-${id}`, id, Date.now() + 86_400_000],
    );
  }
  const test = createTestEnv(d1);
  const sent: Sent[] = [];
  const answers = new Map<string, number>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init: RequestInit) => {
    sent.push({
      endpoint: String(input),
      headers: new Headers(init.headers),
      body: init.body as Uint8Array,
    });
    return new Response(null, { status: answers.get(String(input)) ?? 201 });
  }) as typeof fetch;
  return {
    ...test,
    sqlite,
    d1,
    sent,
    answers,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

async function device(d1: D1Database, user: UserId, name: string) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const endpoint = `https://fcm.googleapis.com/fcm/send/${name}`;
  await saveSubscription(d1, user, {
    endpoint,
    p256dh: raw.toBase64({ alphabet: "base64url", omitPadding: true }),
    auth: crypto
      .getRandomValues(new Uint8Array(16))
      .toBase64({ alphabet: "base64url", omitPadding: true }),
    userAgent: null,
    expiresAt: null,
  });
  return endpoint;
}

let serial = 0;
const inbound = (mailboxId: MailboxId = MAILBOX_A, subject = "Hello") => {
  serial += 1;
  return {
    source: "inbound" as const,
    mailboxId,
    raw: eml({ subject, messageId: `push-${serial}@example.org` }),
    envelope: { from: "alice@example.org", to: "support@example.com" },
  };
};

test("inbound mail reaches every device of everyone with access", async () => {
  const w = world();
  try {
    const a = await device(w.d1, ALICE, "a");
    const b = await device(w.d1, BOB, "b");
    await ingest(w.env, inbound());
    const instance = w.instanceOf(MAILBOX_A);
    expect(instance.alarm).not.toBeNull();
    await instance.fireAlarm();

    expect(w.sent.map((one) => one.endpoint).sort()).toEqual([a, b].sort());
    const [first] = w.sent;
    expect(first?.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(first?.headers.get("Authorization")).toStartWith("vapid t=");
    expect(new TextDecoder().decode(first?.body)).not.toContain("Hello");
    expect(instance.alarm).toBeNull();
  } finally {
    w.restore();
  }
});

test.each([
  ["imported", { source: "import" as const, fallbackDate: null }],
  ["sent", { source: "sent" as const }],
])("%s mail tells nobody", async (_name, source) => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    await ingest(w.env, {
      ...source,
      mailboxId: MAILBOX_A,
      raw: eml({ messageId: `quiet-${_name}@example.org` }),
    });
    const instance = w.instanceOf(MAILBOX_A);
    expect(instance.db.exec("SELECT * FROM push_outbox").toArray()).toEqual([]);
    expect(instance.alarm).toBeNull();
    expect(w.sent).toEqual([]);
  } finally {
    w.restore();
  }
});

test("a repeated delivery of the same message tells nobody twice", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    const message = inbound();
    await ingest(w.env, message);
    await ingest(w.env, message);
    const instance = w.instanceOf(MAILBOX_A);
    await instance.fireAlarm();
    await ingest(w.env, message);
    if (instance.alarm !== null) await instance.fireAlarm();
    expect(w.sent).toHaveLength(1);
  } finally {
    w.restore();
  }
});

test("only the inbox announces, so Spam and anything filed away stay quiet", () => {
  expect(FOLDERS.filter(announces)).toEqual(["inbox"]);
});

test("mail moved to Spam before its notification goes out is not announced", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    await ingest(w.env, inbound());
    const instance = w.instanceOf(MAILBOX_A);
    instance.db.exec("UPDATE messages SET folder = 'spam'");
    await instance.fireAlarm();
    expect(w.sent).toEqual([]);
  } finally {
    w.restore();
  }
});

test("someone removed from the mailbox after the mail arrived gets nothing", async () => {
  const w = world();
  try {
    const a = await device(w.d1, ALICE, "a");
    await device(w.d1, BOB, "b");
    await ingest(w.env, inbound());
    w.sqlite.run("DELETE FROM mailbox_access WHERE user_id = ?", [BOB]);
    await w.instanceOf(MAILBOX_A).fireAlarm();
    expect(w.sent.map((one) => one.endpoint)).toEqual([a]);
  } finally {
    w.restore();
  }
});

test("someone removed after a notice was queued for them gets nothing", async () => {
  const w = world();
  try {
    await device(w.d1, BOB, "b");
    await ingest(w.env, inbound());
    const instance = w.instanceOf(MAILBOX_A);
    const store = new PushStore(instance.db);
    const [row] = w.sqlite.query("SELECT id FROM push_subscriptions").all() as {
      id: string;
    }[];
    store.flush(
      store.waitingNotice()?.notice ?? null,
      [{ subscriptionId: row?.id as string, userId: BOB }],
      store.newestWaitingId() as MessageId,
      Date.now(),
    );
    w.sqlite.run("DELETE FROM mailbox_access WHERE user_id = ?", [BOB]);
    instance.alarm = Date.now();
    await instance.fireAlarm();
    expect(w.sent).toEqual([]);
    expect(instance.db.exec("SELECT * FROM push_deliveries").toArray()).toEqual(
      [],
    );
  } finally {
    w.restore();
  }
});

test("mail arriving during a flush waits for the next one", () => {
  const w = world();
  try {
    const instance = w.instanceOf(MAILBOX_A);
    const store = new PushStore(instance.db);
    instance.db.exec("INSERT INTO threads (created_at) VALUES (1)");
    for (const id of [1, 2]) {
      instance.db.exec(
        `INSERT INTO messages (id, raw_hash, raw_size, r2_prefix, source, parse_status, refs, thread_id, reply_to, to_addresses, cc_addresses, participants, normalized_subject, is_orphan_reply, snippet, received_at, thread_date, is_read, folder, has_attachments)
        VALUES (?, ?, 1, 'p', 'inbound', 'parsed', '[]', 1, '[]', '[]', '[]', '[]', '', 0, '', 1, 1, 0, 'inbox', 0)`,
        id,
        `hash-${id}`,
      );
    }
    store.enqueue(1 as MessageId, MAILBOX_A, 5);
    const upTo = store.newestWaitingId() as MessageId;
    store.enqueue(2 as MessageId, MAILBOX_A, 5);
    store.flush(null, [], upTo, 5);
    expect(store.newestWaitingId()).toBe(2 as MessageId);
  } finally {
    w.restore();
  }
});

test("removing a device only ever removes the caller's own", async () => {
  const w = world();
  try {
    const endpoint = await device(w.d1, ALICE, "a");
    await removeSubscription(w.d1, BOB, endpoint);
    expect(
      w.sqlite.query("SELECT id FROM push_subscriptions").all(),
    ).toHaveLength(1);
    await removeSubscription(w.d1, ALICE, endpoint);
    expect(w.sqlite.query("SELECT id FROM push_subscriptions").all()).toEqual(
      [],
    );
  } finally {
    w.restore();
  }
});

test("a banned person and a person with no live session get nothing", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    await device(w.d1, BOB, "b");
    await ingest(w.env, inbound());
    w.sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [ALICE]);
    w.sqlite.run("DELETE FROM session WHERE user_id = ?", [BOB]);
    await w.instanceOf(MAILBOX_A).fireAlarm();
    expect(w.sent).toEqual([]);
  } finally {
    w.restore();
  }
});

test("a session unused for 61 days gets no notification, and one used on day 50 does", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    await device(w.d1, BOB, "b");
    await ingest(w.env, inbound());
    const day = 86_400_000;
    // Alice's 60 day session ended a day ago. Bob's was renewed 50 days ago.
    w.sqlite.run("UPDATE session SET expires_at = ? WHERE user_id = ?", [
      Date.now() - day,
      ALICE,
    ]);
    w.sqlite.run("UPDATE session SET expires_at = ? WHERE user_id = ?", [
      Date.now() + 10 * day,
      BOB,
    ]);
    await w.instanceOf(MAILBOX_A).fireAlarm();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.endpoint).toEndWith("/b");
  } finally {
    w.restore();
  }
});

test.each([404, 410])("a %i removes the device for good", async (status) => {
  const w = world();
  try {
    const a = await device(w.d1, ALICE, "a");
    w.answers.set(a, status);
    await ingest(w.env, inbound());
    await w.instanceOf(MAILBOX_A).fireAlarm();
    expect(w.sqlite.query("SELECT * FROM push_subscriptions").all()).toEqual(
      [],
    );
    expect(
      w
        .instanceOf(MAILBOX_A)
        .db.exec("SELECT * FROM push_deliveries")
        .toArray(),
    ).toEqual([]);
  } finally {
    w.restore();
  }
});

test("a busy push service is tried again later, then given up on", async () => {
  const w = world();
  try {
    const a = await device(w.d1, ALICE, "a");
    w.answers.set(a, 503);
    await ingest(w.env, inbound());
    const instance = w.instanceOf(MAILBOX_A);
    await instance.fireAlarm();
    expect(instance.alarm).toBeGreaterThan(Date.now());
    for (let i = 0; i < 10 && instance.alarm !== null; i += 1) {
      await instance.fireAlarm();
    }
    expect(w.sent).toHaveLength(5);
    expect(instance.alarm).toBeNull();
    expect(
      w.sqlite.query("SELECT * FROM push_subscriptions").all(),
    ).toHaveLength(1);
  } finally {
    w.restore();
  }
});

test("a crash before the push service answers sends the notice again", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    await ingest(w.env, inbound());
    const instance = w.instanceOf(MAILBOX_A);
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("the connection dropped");
    }) as unknown as typeof fetch;
    await instance.fireAlarm();
    globalThis.fetch = real;
    expect(w.sent).toEqual([]);
    expect(instance.alarm).not.toBeNull();
    await instance.fireAlarm();
    expect(w.sent).toHaveLength(1);
  } finally {
    w.restore();
  }
});

test("a job that cannot reach the database waits rather than spinning", async () => {
  const { env, instanceOf } = createTestEnv();
  await ingest(env, inbound());
  const instance = instanceOf(MAILBOX_A);
  await instance.fireAlarm();
  const next = instance.alarm as number;
  expect(next).toBeGreaterThan(Date.now() + PUSH_WINDOW_MS / 2);
});

test("a flood of mail sends far fewer notifications than messages", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    await device(w.d1, BOB, "b");
    const instance = w.instanceOf(MAILBOX_A);
    await ingest(w.env, inbound());
    await instance.fireAlarm();
    expect(w.sent).toHaveLength(2);

    for (let i = 0; i < 300; i += 1) await ingest(w.env, inbound());
    expect(instance.alarm).toBeGreaterThan(Date.now());
    await instance.fireAlarm();
    expect(w.sent).toHaveLength(4);
    expect(instance.alarm).toBeNull();
    expect(instance.db.exec("SELECT * FROM push_outbox").toArray()).toEqual([]);
  } finally {
    w.restore();
  }
});

test("mail arriving in a burst after the first becomes one summary", () => {
  const w = world();
  try {
    const instance = w.instanceOf(MAILBOX_A);
    const store = new PushStore(instance.db);
    instance.db.exec("INSERT INTO threads (created_at) VALUES (1)");
    for (const id of [1, 2, 3]) {
      instance.db.exec(
        `INSERT INTO messages (id, raw_hash, raw_size, r2_prefix, source, parse_status, refs, thread_id, reply_to, to_addresses, cc_addresses, participants, normalized_subject, is_orphan_reply, snippet, received_at, thread_date, is_read, folder, has_attachments, subject, from_address)
        VALUES (?, ?, 1, 'p', 'inbound', 'parsed', '[]', 1, '[]', '[]', '[]', '[]', '', 0, '', 1, 1, 0, 'inbox', 0, 'Secret subject', 'a@x.org')`,
        id,
        `hash-${id}`,
      );
      store.enqueue(id as MessageId, MAILBOX_A, 1);
    }
    const waiting = store.waitingNotice();
    expect(waiting?.notice).toEqual({
      kind: "summary",
      mailboxId: MAILBOX_A,
      count: 3,
    });
    expect(JSON.stringify(waiting)).not.toContain("Secret");
  } finally {
    w.restore();
  }
});

test("mail read or moved before its notification goes out is not announced", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    await ingest(w.env, inbound());
    const instance = w.instanceOf(MAILBOX_A);
    instance.db.exec("UPDATE messages SET is_read = 1");
    await instance.fireAlarm();
    expect(w.sent).toEqual([]);
    expect(instance.alarm).toBeNull();
  } finally {
    w.restore();
  }
});

test("a large fan-out spreads over several alarms", async () => {
  const w = world();
  try {
    const people = Math.ceil(MAX_SENDS_PER_RUN * 1.5);
    for (let i = 0; i < people; i += 1) {
      const id = `user-${i}` as UserId;
      w.sqlite.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
        id,
        id,
        `${id}@example.com`,
      ]);
      w.sqlite.run(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'member')",
        [MAILBOX_A, id],
      );
      w.sqlite.run(
        "INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES (?, ?, ?, ?, 0)",
        [`s-${id}`, `t-${id}`, id, Date.now() + 86_400_000],
      );
      await device(w.d1, id, `person-${i}`);
    }
    await ingest(w.env, inbound());
    const instance = w.instanceOf(MAILBOX_A);
    await instance.fireAlarm();
    expect(w.sent).toHaveLength(MAX_SENDS_PER_RUN);
    await instance.fireAlarm();
    expect(w.sent).toHaveLength(people);
    expect(new Set(w.sent.map((one) => one.endpoint)).size).toBe(people);
    expect(instance.alarm).toBeNull();
  } finally {
    w.restore();
  }
});

test("muting a mailbox silences it for that person alone", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    const b = await device(w.d1, BOB, "b");
    const instance = w.instanceOf(MAILBOX_A);
    instance.object.setPushMuted(ALICE, true);
    expect(instance.object.pushMuted(ALICE)).toBe(true);
    await ingest(w.env, inbound());
    await instance.fireAlarm();
    expect(w.sent.map((one) => one.endpoint)).toEqual([b]);
  } finally {
    w.restore();
  }
});

test("mail arriving while Mail is off is stored and never announced", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    w.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
    const result = await ingest(w.env, inbound());
    expect(result.status).toBe("stored");
    const instance = w.instanceOf(MAILBOX_A);
    await instance.fireAlarm();
    expect(w.sent).toEqual([]);
    expect(instance.alarm).toBeNull();

    w.sqlite.run("DELETE FROM app_settings");
    if (instance.alarm !== null) await instance.fireAlarm();
    expect(w.sent).toEqual([]);
  } finally {
    w.restore();
  }
});

test("mail arriving while Mail is off stays quiet if Mail is back on before the alarm", async () => {
  const w = world();
  try {
    await device(w.d1, ALICE, "a");
    w.sqlite.run(
      "INSERT INTO addresses (address, domain, mailbox_id, kind) VALUES ('support@example.com', 'example.com', ?, 'primary')",
      [MAILBOX_A],
    );
    w.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
    const { raw, envelope } = inbound();
    await receiveInbound(
      {
        ...envelope,
        rawSize: raw.byteLength,
        raw: new Response(raw).body!,
      } as unknown as ForwardableEmailMessage,
      w.env,
    );
    w.sqlite.run("DELETE FROM app_settings");
    const instance = w.instanceOf(MAILBOX_A);
    expect(
      instance.object.listThreads({ view: { folder: "inbox" } }).threads,
    ).toHaveLength(1);
    if (instance.alarm !== null) await instance.fireAlarm();
    expect(w.sent).toEqual([]);
  } finally {
    w.restore();
  }
});

test("two first uses at the same moment agree on one key pair", async () => {
  const { d1, sqlite } = createTestDatabase();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => ensureVapidKeys(d1)),
  );
  expect(new Set(results.map((one) => one.publicKey)).size).toBe(1);
  expect(new Set(results.map((one) => one.privateKey)).size).toBe(1);
  expect(sqlite.query("SELECT * FROM org_settings").all()).toHaveLength(1);
  expect(results[0]?.publicKey).toBeTruthy();
});

test("creating the keys keeps the organisation's other settings", async () => {
  const { d1, sqlite } = createTestDatabase();
  sqlite.run("INSERT INTO org_settings (id, require_2fa) VALUES (1, 1)");
  await ensureVapidKeys(d1);
  expect(sqlite.query("SELECT require_2fa FROM org_settings").get()).toEqual({
    require_2fa: 1,
  });
});

test("the same browser signing in as someone else moves the device to them", async () => {
  const w = world();
  try {
    const endpoint = await device(w.d1, ALICE, "shared-device");
    await saveSubscription(w.d1, BOB, {
      endpoint,
      p256dh: "new",
      auth: "new",
      userAgent: null,
      expiresAt: null,
    });
    expect(
      w.sqlite.query("SELECT user_id, p256dh FROM push_subscriptions").all(),
    ).toEqual([{ user_id: BOB, p256dh: "new" }]);
  } finally {
    w.restore();
  }
});

test("one person cannot pile up endless devices", async () => {
  const w = world();
  try {
    for (let i = 0; i < MAX_DEVICES_PER_PERSON + 5; i += 1) {
      await device(w.d1, ALICE, `d-${i}`);
    }
    expect(
      w.sqlite.query("SELECT id FROM push_subscriptions").all(),
    ).toHaveLength(MAX_DEVICES_PER_PERSON);
  } finally {
    w.restore();
  }
});

test.each([
  [201, null, "delivered"],
  [410, null, "gone"],
  [404, null, "gone"],
  [429, "120", "retry"],
  [503, null, "retry"],
  [400, null, "refused"],
  [403, null, "refused"],
  [302, null, "refused"],
  [413, null, "refused"],
])("a push service answering %i means %s", (status, retryAfter, kind) => {
  expect(outcomeOf(status as number, retryAfter as string | null).kind).toBe(
    kind as never,
  );
});

test("the message a device receives names who it is for", () => {
  expect(
    parsePushMessage({
      kind: "summary",
      mailboxId: MAILBOX_A,
      count: 2,
      to: ALICE,
    })?.to,
  ).toBe(ALICE);
});
