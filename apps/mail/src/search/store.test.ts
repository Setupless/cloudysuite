import { beforeEach, expect, test } from "bun:test";
import { applyMigrations } from "../migrations";
import type { SqlDriver } from "../sql";
import { MailboxStore } from "../store";
import { createSqlDriver } from "../test-support";
import type { Folder, MessageId, NewMessage, ThreadId } from "../types";
import { SearchStore } from "./store";

let db: SqlDriver;
let store: MailboxStore;
let searcher: SearchStore;
let serial = 0;

beforeEach(() => {
  ({ db } = createSqlDriver());
  applyMigrations(db);
  store = new MailboxStore(db);
  searcher = new SearchStore(db, store);
});

const T0 = Date.UTC(2026, 5, 1);
const alice = { name: "Alice Stone", address: "alice@example.org" };
const bob = { name: "Bob", address: "bob@example.com" };

function deliver(overrides: Partial<NewMessage> = {}) {
  serial += 1;
  return store.commit({
    rawHash: `hash-${serial}`,
    rawSize: 10,
    r2Prefix: `p/${serial}/`,
    source: "inbound",
    envelopeFrom: null,
    envelopeTo: null,
    parseStatus: "parsed",
    rfcMessageId: `id-${serial}@x`,
    references: [],
    subject: `Subject ${serial}`,
    from: alice,
    replyTo: [],
    to: [bob],
    cc: [],
    snippet: `snippet ${serial}`,
    sentAt: T0 + serial,
    receivedAt: T0 + serial,
    authResults: null,
    searchBody: "ordinary words",
    bodies: [],
    attachments: [],
    ...overrides,
  });
}

const search = (text: string, cursor?: string) =>
  searcher.search({ text, offsetMinutes: 0, cursor });
const found = (text: string) => search(text).threads.map((row) => row.id);
const move = (threadId: ThreadId, folder: Folder) =>
  store.moveToFolder({ threadIds: [threadId] }, folder);

test("words match anywhere and operators match their own field", () => {
  const fromAlice = deliver({ subject: "Budget" });
  const fromBob = deliver({ from: bob, to: [alice], searchBody: "budget too" });
  expect(found("budget").sort()).toEqual(
    [fromAlice.threadId, fromBob.threadId].sort(),
  );
  expect(found("subject:budget")).toEqual([fromAlice.threadId]);
  expect(found("from:bob")).toEqual([fromBob.threadId]);
  expect(found("from:alice@example.org budget")).toEqual([fromAlice.threadId]);
  expect(found("to:alice")).toEqual([fromBob.threadId]);
});

test("a quoted phrase needs the words in order", () => {
  const hit = deliver({ searchBody: "the quick brown fox" });
  deliver({ searchBody: "brown and quick" });
  expect(found('"quick brown"')).toEqual([hit.threadId]);
});

test("state operators filter", () => {
  const starred = deliver();
  const read = deliver();
  const withFile = deliver({
    attachments: [
      {
        position: 0,
        filename: "a.pdf",
        mimeType: "application/pdf",
        inline: false,
        contentId: null,
        size: 1,
        r2Key: "k",
      },
    ],
  });
  store.setFlags({ messageIds: [starred.messageId] }, { starred: true });
  store.setFlags({ messageIds: [read.messageId] }, { read: true });
  expect(found("is:starred")).toEqual([starred.threadId]);
  expect(found("has:attachment")).toEqual([withFile.threadId]);
  expect(found("is:unread")).not.toContain(read.threadId);
});

test("Spam and Trash stay out until they are asked for", () => {
  const spam = deliver({ searchBody: "prize" });
  const trash = deliver({ searchBody: "prize" });
  const kept = deliver({ searchBody: "prize" });
  move(spam.threadId, "spam");
  move(trash.threadId, "trash");
  expect(found("prize")).toEqual([kept.threadId]);
  expect(found("prize in:spam")).toEqual([spam.threadId]);
  expect(found("prize in:trash")).toEqual([trash.threadId]);
});

test("dates bound when a message arrived", () => {
  const march = deliver({ receivedAt: Date.UTC(2026, 2, 15) });
  const april = deliver({ receivedAt: Date.UTC(2026, 3, 15) });
  expect(found("before:2026-04-01")).toEqual([march.threadId]);
  expect(found("after:2026-04-01")).toEqual([april.threadId]);
  expect(found("after:2026-03-15 before:2026-03-16")).toEqual([march.threadId]);
});

test("a label operator finds its label and explains an unknown one", () => {
  db.exec("INSERT INTO labels (id, name, created_at) VALUES (5, 'To do', 0)");
  const labelled = deliver();
  deliver();
  db.exec(
    "INSERT INTO message_labels (message_id, label_id) VALUES (?, 5)",
    labelled.messageId,
  );
  expect(found('label:"to DO"')).toEqual([labelled.threadId]);
  expect(search("label:nothing").problem).toBe(
    `You don't have a label called "nothing".`,
  );
});

test("a thread shows once, with its newest match's snippet and date", () => {
  const first = deliver({
    rfcMessageId: "root@x",
    searchBody: "kiwi",
    snippet: "first kiwi",
    receivedAt: T0,
  });
  deliver({
    rfcMessageId: "reply@x",
    references: ["root@x"],
    searchBody: "kiwi again",
    snippet: "second kiwi",
    receivedAt: T0 + 50,
  });
  deliver({
    rfcMessageId: "other@x",
    references: ["root@x"],
    searchBody: "no match here",
    snippet: "third",
    receivedAt: T0 + 90,
  });
  const { threads } = search("kiwi");
  expect(threads).toHaveLength(1);
  expect(threads[0]).toMatchObject({
    id: first.threadId,
    snippet: "second kiwi",
    lastMessageAt: T0 + 50,
    messageCount: 3,
    folders: ["inbox"],
  });
});

test("a conversation with a trashed reply reads only its live messages", () => {
  const root = deliver({ rfcMessageId: "r@x", searchBody: "fig" });
  const reply = deliver({
    rfcMessageId: "s@x",
    references: ["r@x"],
    searchBody: "fig",
  });
  store.moveToFolder({ messageIds: [reply.messageId] }, "trash");
  const [row] = search("fig").threads;
  expect(row).toMatchObject({ messageCount: 1, folders: ["inbox"] });
  expect(row!.id).toBe(root.threadId);
});

test("pages cover every conversation once, in date order", () => {
  const ids = Array.from(
    { length: 120 },
    () => deliver({ searchBody: "pear" }).threadId,
  );
  const seen: ThreadId[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = search("pear", cursor);
    seen.push(...page.threads.map((row) => row.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor);
  expect(pages).toBe(3);
  expect(seen).toEqual(ids.toReversed());
});

test("hostile search text returns results or a plain message, and never throws", () => {
  deliver({ searchBody: "near or col x and not" });
  for (const text of [
    '"',
    "*",
    "NEAR(",
    "OR OR",
    "col:x",
    ")",
    "(",
    "^",
    "AND",
    "NOT",
    "-",
    'subject:"',
    "subject:*",
    "\u0000",
    "\u{1F600}",
    "́",
    Array(32).fill("word").join(" "),
    "y".repeat(500),
    "x".repeat(102_400),
  ]) {
    const page = search(text);
    expect(page.threads.length > 0 || page.nextCursor === null).toBe(true);
  }
  expect(found("OR OR")).toHaveLength(1);
  expect(found("NEAR(")).toHaveLength(1);
  expect(found("col:x")).toHaveLength(1);
});

test("a nonsense cursor starts from the beginning", () => {
  const hit = deliver({ searchBody: "plum" });
  expect(search("plum", "garbage").threads[0]!.id).toBe(hit.threadId);
});

test("a deleted message stops matching", () => {
  const gone = deliver({ searchBody: "melon" });
  move(gone.threadId, "trash");
  store.deleteForever({ messageIds: [gone.messageId as MessageId] });
  expect(found("melon in:trash")).toEqual([]);
});
