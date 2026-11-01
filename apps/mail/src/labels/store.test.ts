import { beforeEach, expect, test } from "bun:test";
import { applyMigrations } from "../migrations";
import type { SqlDriver } from "../sql";
import { RuleStore } from "../rules/store";
import { MailboxStore } from "../store";
import { createSqlDriver } from "../test-support";
import type { LabelId, NewMessage } from "../types";
import { cleanLabelName, LabelStore, MAX_LABELS } from "./store";

let db: SqlDriver;
let store: MailboxStore;
let labels: LabelStore;
let serial = 0;

beforeEach(() => {
  ({ db } = createSqlDriver());
  applyMigrations(db);
  store = new MailboxStore(db);
  labels = new LabelStore(db, new RuleStore(db));
});

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
    from: { name: "Alice", address: "alice@example.org" },
    replyTo: [],
    to: [],
    cc: [],
    snippet: "snippet",
    sentAt: serial,
    receivedAt: serial,
    authResults: null,
    searchBody: "body",
    bodies: [],
    attachments: [],
    ...overrides,
  });
}

function created(name: string): LabelId {
  const write = labels.create(name, "accent");
  if (!write.ok) throw new Error(write.message);
  return write.label.id;
}

const count = (labelId: LabelId) =>
  store.summary().labels.find((label) => label.id === labelId)?.unread;
const rowsInLabel = (labelId: LabelId) =>
  store.listThreads({ view: { labelId } }).threads;

test("a label can be created, renamed, and recoloured", () => {
  const id = created("Work");
  expect(labels.update(id, { name: "Projects" })).toMatchObject({
    ok: true,
    label: { name: "Projects", colour: "accent" },
  });
  expect(labels.update(id, { colour: "danger" })).toMatchObject({
    ok: true,
    label: { name: "Projects", colour: "danger" },
  });
  expect(store.summary().labels).toEqual([
    { id, name: "Projects", colour: "danger", unread: 0 },
  ]);
});

test("two labels can't share a name, whatever the case", () => {
  created("Work");
  const other = created("Home");
  expect(labels.create("WORK", "accent")).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(labels.update(other, { name: "work" })).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(labels.update(other, { name: "HOME" })).toMatchObject({ ok: true });
});

test("a label that is gone can't be changed or applied", () => {
  const id = created("Old");
  const { threadId } = deliver();
  labels.delete(id);
  expect(labels.update(id, { name: "New" })).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(store.setLabel({ threadIds: [threadId] }, id, true)).toBe(false);
});

test("a mailbox has a limit on labels", () => {
  for (let index = 0; index < MAX_LABELS; index += 1) created(`L${index}`);
  expect(labels.create("One more", "accent")).toMatchObject({ ok: false });
});

test("names lose what could disguise them and stay as typed otherwise", () => {
  expect(cleanLabelName("  Work\u0000 ‮now  ")).toBe("Work now");
  expect(cleanLabelName("<img src=x onerror=alert(1)>")).toBe(
    "<img src=x onerror=alert(1)>",
  );
  expect(cleanLabelName(" ​ ")).toBeNull();
  expect(cleanLabelName("x".repeat(65))).toBeNull();
});

test("an invisible character can't make a second label that looks the same", () => {
  expect(cleanLabelName("Work\u034F")).toBe("Work");
  expect(cleanLabelName("Wo\u200Brk\uFE0F\u00AD")).toBe("Work");
  const first = labels.create(cleanLabelName("Work")!, "accent");
  const second = labels.create(cleanLabelName("Work\u034F")!, "accent");
  expect(first.ok).toBe(true);
  expect(second).toMatchObject({ ok: false, status: 409 });
});

test("applying and removing a label shows in its list and its count", () => {
  const id = created("Work");
  const { threadId } = deliver();
  store.setLabel({ threadIds: [threadId] }, id, true);
  expect(rowsInLabel(id).map((row) => row.id)).toEqual([threadId]);
  expect(count(id)).toBe(1);
  expect(store.getThread(threadId)!.messages[0]!.labelIds).toEqual([id]);
  expect(
    store.listThreads({ view: { folder: "inbox" } }).threads[0],
  ).toMatchObject({
    labelIds: [id],
  });

  store.setFlags({ threadIds: [threadId] }, { read: true });
  expect(count(id)).toBe(0);

  store.setLabel({ threadIds: [threadId] }, id, false);
  expect(rowsInLabel(id)).toEqual([]);
  expect(store.getThread(threadId)!.messages[0]!.labelIds).toEqual([]);
});

test("a reply joins its conversation's labels and counts in them", () => {
  const id = created("Work");
  const root = deliver({ rfcMessageId: "r@x" });
  store.setLabel({ threadIds: [root.threadId] }, id, true);
  store.setFlags({ threadIds: [root.threadId] }, { read: true });
  expect(count(id)).toBe(0);

  deliver({ rfcMessageId: "s@x", references: ["r@x"], snippet: "the reply" });
  expect(count(id)).toBe(1);
  expect(rowsInLabel(id)[0]).toMatchObject({
    snippet: "the reply",
    messageCount: 2,
  });
});

test("merging two threads keeps both sets of labels and one row", () => {
  const work = created("Work");
  const home = created("Home");
  const left = deliver({ rfcMessageId: "left@x" });
  const right = deliver({ rfcMessageId: "right@x" });
  store.setLabel({ threadIds: [left.threadId] }, work, true);
  store.setLabel({ threadIds: [right.threadId] }, home, true);
  expect(count(work)).toBe(1);
  expect(count(home)).toBe(1);

  const bridge = deliver({
    rfcMessageId: "bridge@x",
    references: ["left@x", "right@x"],
  });
  expect(bridge.threadId).toBe(left.threadId);
  expect(rowsInLabel(work).map((row) => row.id)).toEqual([left.threadId]);
  expect(rowsInLabel(home).map((row) => row.id)).toEqual([left.threadId]);
  expect(count(work)).toBe(1);
  expect(count(home)).toBe(1);
  expect(
    store
      .listThreads({ view: { folder: "inbox" } })
      .threads[0]!.labelIds.sort(),
  ).toEqual([work, home].sort());
});

test("Spam and Trash leave a label's list and count, and coming back restores them", () => {
  const id = created("Work");
  const { threadId } = deliver();
  store.setLabel({ threadIds: [threadId] }, id, true);
  store.moveToFolder({ threadIds: [threadId] }, "trash");
  expect(rowsInLabel(id)).toEqual([]);
  expect(count(id)).toBe(0);
  store.restore({ threadIds: [threadId] });
  expect(rowsInLabel(id).map((row) => row.id)).toEqual([threadId]);
  expect(count(id)).toBe(1);
});

test("a move across folders takes only the folders it names", () => {
  const root = deliver({ rfcMessageId: "r@x" });
  const sent = deliver({
    rfcMessageId: "s@x",
    references: ["r@x"],
    source: "sent",
  });
  store.moveToFolder(
    { threadIds: [root.threadId], inFolder: ["inbox"] },
    "archive",
  );
  const folders = () =>
    store.getThread(root.threadId)!.messages.map((message) => message.folder);
  expect(folders()).toEqual(["archive", "sent"]);
  store.moveToFolder(
    { threadIds: [sent.threadId], inFolder: ["inbox", "archive", "sent"] },
    "trash",
  );
  expect(folders()).toEqual(["trash", "trash"]);
});

test("deleting a label leaves no rows behind and the read model as a refresh would", () => {
  const id = created("Work");
  const other = created("Home");
  const threads = [deliver(), deliver(), deliver()];
  for (const { threadId } of threads) {
    store.setLabel({ threadIds: [threadId] }, id, true);
  }
  store.setLabel({ threadIds: [threads[0]!.threadId] }, other, true);

  labels.delete(id);
  const dump = () =>
    db.exec("SELECT * FROM thread_views ORDER BY view, thread_id").toArray();
  const afterDelete = dump();
  for (const { threadId } of threads) store.refreshThread(threadId);
  expect(dump()).toEqual(afterDelete);

  expect(
    db.exec("SELECT * FROM message_labels WHERE label_id = ?", id).toArray(),
  ).toEqual([]);
  expect(
    db
      .exec("SELECT * FROM thread_views WHERE view = ?", `label:${id}`)
      .toArray(),
  ).toEqual([]);
  expect(store.summary().labels.map((label) => label.id)).toEqual([other]);
  expect(rowsInLabel(other)).toHaveLength(1);
});

test("deleting a message takes its labels with it", () => {
  const id = created("Work");
  const { threadId, messageId } = deliver();
  store.setLabel({ threadIds: [threadId] }, id, true);
  store.moveToFolder({ threadIds: [threadId] }, "trash");
  store.deleteForever({ messageIds: [messageId] });
  expect(db.exec("SELECT * FROM message_labels").toArray()).toEqual([]);
  expect(count(id)).toBe(0);
});
