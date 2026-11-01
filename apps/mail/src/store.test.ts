import { beforeEach, expect, test } from "bun:test";
import { applyMigrations } from "./migrations";
import type { SqlDriver } from "./sql";
import { MailboxStore, sweepDeletions } from "./store";
import { createSqlDriver, FakeBucket } from "./test-support";
import type { LabelId, MessageId, NewMessage, ThreadId } from "./types";

let db: SqlDriver;
let store: MailboxStore;
let nextHash = 0;

beforeEach(() => {
  ({ db } = createSqlDriver());
  applyMigrations(db);
  store = new MailboxStore(db);
});

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);
const alice = { name: "Alice", address: "alice@example.org" };
const bob = { name: "Bob", address: "bob@example.com" };
const carol = { name: "Carol", address: "carol@example.net" };

function message(overrides: Partial<NewMessage> = {}): NewMessage {
  nextHash += 1;
  const rawHash = overrides.rawHash ?? `hash-${nextHash}`;
  return {
    rawHash,
    rawSize: 10,
    r2Prefix: `mailboxes/m/messages/${rawHash}/`,
    source: "inbound",
    envelopeFrom: "alice@example.org",
    envelopeTo: "bob@example.com",
    parseStatus: "parsed",
    rfcMessageId: null,
    references: [],
    subject: "Subject",
    from: alice,
    replyTo: [],
    to: [bob],
    cc: [],
    snippet: "snippet",
    sentAt: T0,
    receivedAt: T0,
    authResults: null,
    searchBody: "body",
    bodies: [],
    attachments: [],
    ...overrides,
  };
}

const search = (query: string) =>
  db
    .exec<{ rowid: number }>(
      "SELECT rowid FROM message_search WHERE message_search MATCH ?",
      query,
    )
    .toArray()
    .map((row) => row.rowid);

test("the same raw hash stores one message, and a repeat reports the first", () => {
  const first = store.commit(message({ rawHash: "same" }));
  const second = store.commit(message({ rawHash: "same", subject: "Other" }));
  expect(first.status).toBe("stored");
  expect(second).toEqual({ ...first, status: "duplicate" });
  expect(db.exec("SELECT id FROM messages").toArray()).toHaveLength(1);
  expect(store.findByHash("same")?.messageId).toBe(first.messageId);
  expect(store.findByHash("other")).toBeNull();
});

test("two different messages with one Message-ID are both kept, in one thread", () => {
  const a = store.commit(message({ rfcMessageId: "x@y" }));
  const b = store.commit(message({ rfcMessageId: "x@y" }));
  expect(b.status).toBe("stored");
  expect(b.messageId).not.toBe(a.messageId);
  expect(b.threadId).toBe(a.threadId);
});

test("each source lands where it should, and only inbound reaches triage", () => {
  const inbound = store.commit(message({ source: "inbound" }));
  const imported = store.commit(message({ source: "import", subject: "b" }));
  const sent = store.commit(message({ source: "sent", subject: "c" }));
  expect([inbound.folder, imported.folder, sent.folder]).toEqual([
    "inbox",
    "archive",
    "sent",
  ]);
  const readFlag = (threadId: ThreadId) =>
    store.getThread(threadId)!.messages[0]!.read;
  expect(readFlag(inbound.threadId)).toBe(false);
  expect(readFlag(imported.threadId)).toBe(true);
  expect(readFlag(sent.threadId)).toBe(true);
});

function threadGroups(ids: string[]): string[][] {
  const rows = db
    .exec<{ rfc_message_id: string; thread_id: number }>(
      "SELECT rfc_message_id, thread_id FROM messages",
    )
    .toArray();
  const groups = Map.groupBy(rows, (row) => row.thread_id);
  expect(rows).toHaveLength(ids.length);
  return [...groups.values()]
    .map((group) => group.map((row) => row.rfc_message_id).sort())
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function permutations<Item>(items: Item[]): Item[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations(items.toSpliced(index, 1)).map((rest) => [item, ...rest]),
  );
}

function expectConvergence(messages: NewMessage[], expected: string[][]): void {
  for (const order of permutations(messages)) {
    ({ db } = createSqlDriver());
    applyMigrations(db);
    store = new MailboxStore(db);
    for (const item of order) store.commit(item);
    expect(threadGroups(messages.map((m) => m.rfcMessageId!))).toEqual(
      expected,
    );

    // The read model holds exactly one row per thread, with every message counted.
    const views = db
      .exec<{ thread_id: number; message_count: number }>(
        "SELECT thread_id, message_count FROM thread_views",
      )
      .toArray();
    expect(views.map((row) => row.message_count).sort()).toEqual(
      expected.map((group) => group.length).sort(),
    );
  }
}

test("a chain of replies forms one thread in every order of arrival", () => {
  expectConvergence(
    [
      message({ rfcMessageId: "a" }),
      message({ rfcMessageId: "b", references: ["a"] }),
      message({ rfcMessageId: "c", references: ["a", "b"] }),
      message({ rfcMessageId: "d", references: ["c"] }),
      message({ rfcMessageId: "z", subject: "Unrelated" }),
    ],
    [["a", "b", "c", "d"], ["z"]],
  );
});

test("replies whose parent never arrives still group together", () => {
  expectConvergence(
    [
      message({ rfcMessageId: "b", references: ["lost"] }),
      message({ rfcMessageId: "c", references: ["lost"] }),
      message({ rfcMessageId: "d", references: ["other-lost"] }),
    ],
    [["b", "c"], ["d"]],
  );
});

test("a header link wins even when the subject changes", () => {
  const first = store.commit(message({ rfcMessageId: "a", subject: "Lunch?" }));
  const reply = store.commit(
    message({ rfcMessageId: "b", references: ["a"], subject: "New topic" }),
  );
  expect(reply.threadId).toBe(first.threadId);
});

test("a reply missing its headers joins by subject and people, in every order", () => {
  expectConvergence(
    [
      message({ rfcMessageId: "a", subject: "Lunch?", sentAt: T0 }),
      message({
        rfcMessageId: "b",
        subject: "RE: lunch?",
        from: bob,
        to: [alice],
        sentAt: T0 + DAY,
      }),
      message({
        rfcMessageId: "c",
        subject: "Re: Lunch?",
        sentAt: T0 + 2 * DAY,
      }),
    ],
    [["a", "b", "c"]],
  );
});

test("the same subject chained through the window converges in every order", () => {
  expectConvergence(
    [
      message({ rfcMessageId: "a", subject: "Plan", sentAt: T0 }),
      message({ rfcMessageId: "b", subject: "Re: Plan", sentAt: T0 + 6 * DAY }),
      message({
        rfcMessageId: "c",
        subject: "Re: Plan",
        sentAt: T0 + 12 * DAY,
      }),
    ],
    [["a", "b", "c"]],
  );
});

test("unrelated mails with the same plain subject never join", () => {
  expectConvergence(
    [
      message({ rfcMessageId: "a", subject: "hello", sentAt: T0 }),
      message({ rfcMessageId: "b", subject: "hello", sentAt: T0 + 1000 }),
      message({ rfcMessageId: "c", subject: "Hello", sentAt: T0 + 2000 }),
    ],
    [["a"], ["b"], ["c"]],
  );
});

test("a headerless reply outside the window starts a new thread", () => {
  expectConvergence(
    [
      message({ rfcMessageId: "a", subject: "Plan", sentAt: T0 }),
      message({ rfcMessageId: "b", subject: "Re: Plan", sentAt: T0 + 8 * DAY }),
    ],
    [["a"], ["b"]],
  );
});

test("a headerless reply from a stranger does not join by subject", () => {
  expectConvergence(
    [
      message({
        rfcMessageId: "a",
        subject: "Invoice",
        from: alice,
        to: [bob],
      }),
      message({
        rfcMessageId: "b",
        subject: "Re: Invoice",
        from: carol,
        to: [bob],
      }),
    ],
    [["a"], ["b"]],
  );
});

test("a reply with headers that match nothing does not join by subject", () => {
  expectConvergence(
    [
      message({ rfcMessageId: "a", subject: "Status", sentAt: T0 }),
      message({
        rfcMessageId: "b",
        subject: "Re: Status",
        references: ["from-elsewhere"],
        sentAt: T0 + DAY,
      }),
    ],
    [["a"], ["b"]],
  );
});

test("an empty subject never links by subject", () => {
  expectConvergence(
    [
      message({ rfcMessageId: "a", subject: null }),
      message({ rfcMessageId: "b", subject: "Re:" }),
    ],
    [["a"], ["b"]],
  );
});

test("a thread keeps working after a merge removes the other thread", () => {
  const a = store.commit(message({ rfcMessageId: "a", subject: "first" }));
  const c = store.commit(
    message({ rfcMessageId: "c", references: ["b"], subject: "second" }),
  );
  expect(c.threadId).not.toBe(a.threadId);
  const bridge = store.commit(
    message({ rfcMessageId: "b", references: ["a"], subject: "bridge" }),
  );
  const survivor = Math.min(a.threadId, c.threadId) as ThreadId;
  expect(bridge.threadId).toBe(survivor);
  expect(store.getThread(survivor)?.messages).toHaveLength(3);
  const merged = Math.max(a.threadId, c.threadId) as ThreadId;
  expect(store.getThread(merged)).toBeNull();
  const page = store.listThreads({ view: { folder: "inbox" } });
  expect(page.threads.map((thread) => thread.id)).toEqual([survivor]);
  expect(page.threads[0]?.messageCount).toBe(3);
  expect(
    store.commit(message({ rfcMessageId: "d", references: ["c"] })).threadId,
  ).toBe(survivor);
});

test("a message order in a thread follows sent dates, not arrival", () => {
  const reply = store.commit(
    message({ rfcMessageId: "b", references: ["a"], sentAt: T0 + 1000 }),
  );
  store.commit(message({ rfcMessageId: "a", sentAt: T0 }));
  expect(
    store.getThread(reply.threadId)!.messages.map((m) => m.rfcMessageId),
  ).toEqual(["a", "b"]);
});

function seedThreads(count: number): ThreadId[] {
  return Array.from(
    { length: count },
    (_, index) =>
      store.commit(
        message({ subject: `Thread ${index}`, receivedAt: T0 + index * 1000 }),
      ).threadId,
  );
}

test("listing pages through a folder newest first, with no gap or repeat", () => {
  const ids = seedThreads(7);
  const seen: ThreadId[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = store.listThreads({
      view: { folder: "inbox" },
      limit: 3,
      cursor,
    });
    seen.push(...page.threads.map((thread) => thread.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor);
  expect(pages).toBe(3);
  expect(seen).toEqual(ids.toReversed());
});

test("threads with the same time still page without a gap or repeat", () => {
  const ids = Array.from(
    { length: 5 },
    (_, index) =>
      store.commit(message({ subject: `S${index}`, receivedAt: T0 })).threadId,
  );
  const first = store.listThreads({ view: { folder: "inbox" }, limit: 2 });
  const second = store.listThreads({
    view: { folder: "inbox" },
    limit: 3,
    cursor: first.nextCursor!,
  });
  expect(second.nextCursor).toBeNull();
  expect(
    [...first.threads, ...second.threads].map((thread) => thread.id),
  ).toEqual(ids.toReversed());
});

test("a limit and a cursor from a client cannot do harm", () => {
  seedThreads(3);
  const view = { folder: "inbox" } as const;
  expect(store.listThreads({ view, limit: 0 }).threads).toHaveLength(1);
  expect(store.listThreads({ view, limit: 1e9 }).threads).toHaveLength(3);
  expect(
    store.listThreads({ view, cursor: "'; DROP TABLE messages; --" }).threads,
  ).toHaveLength(3);
});

test("a thread summary describes the messages in that folder", () => {
  const first = store.commit(
    message({ rfcMessageId: "a", subject: "Start", snippet: "first text" }),
  );
  store.commit(
    message({
      rfcMessageId: "b",
      references: ["a"],
      subject: "Re: Start",
      from: bob,
      to: [alice],
      snippet: "second text",
      receivedAt: T0 + 1000,
      sentAt: T0 + 1000,
      attachments: [
        {
          position: 0,
          filename: "a.pdf",
          mimeType: "application/pdf",
          inline: false,
          contentId: null,
          size: 3,
          r2Key: "k",
        },
      ],
    }),
  );
  const [summary] = store.listThreads({ view: { folder: "inbox" } }).threads;
  expect(summary).toEqual({
    id: first.threadId,
    subject: "Start",
    snippet: "second text",
    senders: [bob, alice],
    lastMessageAt: T0 + 1000,
    messageCount: 2,
    unreadCount: 2,
    starred: false,
    hasAttachments: true,
    folders: ["inbox"],
    labelIds: [],
  });
});

test("an inline image alone does not count as an attachment", () => {
  store.commit(
    message({
      attachments: [
        {
          position: 0,
          filename: null,
          mimeType: "image/png",
          inline: true,
          contentId: "logo@x",
          size: 3,
          r2Key: "k",
        },
      ],
    }),
  );
  const [summary] = store.listThreads({ view: { folder: "inbox" } }).threads;
  expect(summary?.hasAttachments).toBe(false);
});

test("flags update the message and the list", () => {
  const { messageId, threadId } = store.commit(message());
  expect(store.setFlags({ messageIds: [messageId] }, { read: true })).toBe(1);
  let [summary] = store.listThreads({ view: { folder: "inbox" } }).threads;
  expect(summary?.unreadCount).toBe(0);
  expect(summary?.starred).toBe(false);

  store.setFlags({ threadIds: [threadId] }, { starred: true });
  [summary] = store.listThreads({ view: { folder: "inbox" } }).threads;
  expect(summary?.starred).toBe(true);
  expect(summary?.unreadCount).toBe(0);

  const detail = store.getThread(threadId)!.messages[0]!;
  expect([detail.read, detail.starred]).toEqual([true, true]);
  expect(
    store.setFlags({ messageIds: [999 as MessageId] }, { read: true }),
  ).toBe(0);
});

test("moving a whole thread can leave the sent mail in Sent", () => {
  const first = store.commit(message({ rfcMessageId: "a" }));
  store.commit(
    message({ rfcMessageId: "b", references: ["a"], source: "sent" }),
  );
  const { threadId } = first;
  const inView = (folder: "inbox" | "sent" | "archive") =>
    store.listThreads({ view: { folder } }).threads.map((thread) => thread.id);
  expect(inView("inbox")).toEqual([threadId]);
  expect(inView("sent")).toEqual([threadId]);

  expect(
    store.moveToFolder({ threadIds: [threadId], inFolder: "inbox" }, "archive"),
  ).toEqual([{ messageId: first.messageId, threadId, folder: "inbox" }]);
  expect(inView("inbox")).toEqual([]);
  expect(inView("sent")).toEqual([threadId]);
  expect(inView("archive")).toEqual([threadId]);
});

test("restoring sends each message back to where its kind of mail lands", () => {
  const inbound = store.commit(message({ rfcMessageId: "a@x" }));
  const sent = store.commit(
    message({ source: "sent", references: ["a@x"], rfcMessageId: "b@x" }),
  );
  const imported = store.commit(message({ source: "import" }));
  const selection = {
    messageIds: [inbound.messageId, sent.messageId, imported.messageId],
  };
  store.moveToFolder(selection, "trash");

  const before = store.restore(selection);
  expect(before.map((ref) => ref.folder)).toEqual(["trash", "trash", "trash"]);
  const folderOf = (ref: { threadId: ThreadId; messageId: MessageId }) =>
    store
      .getThread(ref.threadId)!
      .messages.find((one) => one.id === ref.messageId)!.folder;
  expect(folderOf(inbound)).toBe("inbox");
  expect(folderOf(sent)).toBe("sent");
  expect(folderOf(imported)).toBe("archive");
});

test("a message can find its thread after that thread merged into another", () => {
  const first = store.commit(message({ rfcMessageId: "a@x" }));
  const second = store.commit(message({ rfcMessageId: "b@x" }));
  expect(second.threadId).not.toBe(first.threadId);
  store.commit(message({ rfcMessageId: "c@x", references: ["a@x", "b@x"] }));

  expect(store.getThread(second.threadId)).toBeNull();
  expect(store.threadOfMessage(second.messageId)).toBe(first.threadId);
  expect(store.threadOfMessage(999 as MessageId)).toBeNull();
});

test("the summary counts unread conversations in each folder and label", () => {
  const unread = store.commit(message());
  const read = store.commit(message());
  store.setFlags({ messageIds: [read.messageId] }, { read: true });
  store.commit(message({ subject: "Older" }));
  const moved = store.commit(message());
  store.moveToFolder({ messageIds: [moved.messageId] }, "spam");
  db.exec(
    "INSERT INTO labels (name, created_at) VALUES ('work', 1), ('Admin', 2)",
  );
  const [work] = db
    .exec<{ id: number }>("SELECT id FROM labels WHERE name = 'work'")
    .toArray();
  db.exec(
    "INSERT INTO message_labels (message_id, label_id) VALUES (?, ?)",
    unread.messageId,
    work!.id,
  );
  store.refreshThread(unread.threadId);

  const summary = store.summary();
  expect(summary.folderUnread).toEqual({
    inbox: 2,
    sent: 0,
    drafts: 0,
    spam: 1,
    trash: 0,
    archive: 0,
  });
  expect(
    summary.labels.map(({ name, unread: count }) => [name, count]),
  ).toEqual([
    ["Admin", 0],
    ["work", 1],
  ]);
});

test("an unknown folder is refused and changes nothing", () => {
  const { messageId, threadId } = store.commit(message());
  expect(() =>
    store.moveToFolder({ messageIds: [messageId] }, "nowhere" as "inbox"),
  ).toThrow();
  expect(store.getThread(threadId)!.messages[0]!.folder).toBe("inbox");
});

test("listing by label follows labels added and removed", () => {
  const { messageId, threadId } = store.commit(message());
  db.exec("INSERT INTO labels (name, created_at) VALUES ('Work', 1)");
  const [label] = db.exec<{ id: number }>("SELECT id FROM labels").toArray();
  const labelId = label!.id as LabelId;
  const view = { labelId };

  db.exec(
    "INSERT INTO message_labels (message_id, label_id) VALUES (?, ?)",
    messageId,
    labelId,
  );
  store.refreshThread(threadId);
  expect(store.listThreads({ view }).threads.map((t) => t.id)).toEqual([
    threadId,
  ]);
  expect(store.getThread(threadId)!.messages[0]!.labelIds).toEqual([labelId]);

  db.exec("DELETE FROM message_labels");
  store.refreshThread(threadId);
  expect(store.listThreads({ view }).threads).toEqual([]);
});

test("search covers subject, people, and body, and forgets deleted mail", () => {
  const { messageId } = store.commit(
    message({
      subject: "Quarterly numbers",
      from: { name: "Dana", address: "dana@example.org" },
      to: [{ name: "Erin", address: "erin@example.com" }],
      cc: [{ name: "", address: "frank@example.net" }],
      searchBody: "the résumé is attached",
    }),
  );
  for (const query of ["quarterly", "dana", "erin", "frank", "resume"]) {
    expect(search(query)).toEqual([messageId]);
  }
  expect(search("subject:dana")).toEqual([]);
  store.moveToFolder({ messageIds: [messageId] }, "trash");
  expect(search("quarterly")).toEqual([messageId]);
  store.deleteForever({ messageIds: [messageId] });
  expect(search("quarterly")).toEqual([]);
});

test("a body of nearly the row limit stores and searches", () => {
  const body = `needle ${"word ".repeat(200_000)}`;
  const { messageId } = store.commit(
    message({
      bodies: [{ kind: "text", size: body.length, inline: body }],
      searchBody: body,
    }),
  );
  expect(store.bodyRefs(messageId)).toEqual([{ kind: "text", inline: body }]);
  expect(search("needle")).toEqual([messageId]);
});

test("a body row is either inline or in R2, never both or neither", () => {
  const { messageId } = store.commit(message());
  const insert = (inline: string | null, key: string | null) =>
    db.exec(
      "INSERT INTO message_bodies (message_id, kind, inline_content, r2_key, size) VALUES (?, 'text', ?, ?, 1)",
      messageId,
      inline,
      key,
    );
  expect(() => insert("a", "b")).toThrow();
  expect(() => insert(null, null)).toThrow();
});

test("deleting for good only touches trash and spam", () => {
  const { messageId } = store.commit(message());
  expect(store.deleteForever({ messageIds: [messageId] })).toBe(0);
  expect(store.findByHash(`hash-${nextHash}`)).not.toBeNull();
  expect(store.pendingDeletions(10)).toEqual([]);
});

test("deleting for good removes rows, then R2 objects, and can repeat", async () => {
  const bucket = new FakeBucket();
  const a = store.commit(message({ rawHash: "del-a", rfcMessageId: "a" }));
  const b = store.commit(
    message({ rawHash: "del-b", rfcMessageId: "b", references: ["a"] }),
  );
  await bucket.put("mailboxes/m/messages/del-a/raw.eml", new Uint8Array(1));
  await bucket.put(
    "mailboxes/m/messages/del-a/attachments/0",
    new Uint8Array(1),
  );
  await bucket.put("mailboxes/m/messages/del-b/raw.eml", new Uint8Array(1));

  store.moveToFolder({ messageIds: [a.messageId] }, "trash");
  expect(store.deleteForever({ messageIds: [a.messageId] })).toBe(1);

  // The rows go first, so a crash here leaves only a queued clean-up.
  expect(store.getThread(a.threadId)?.messages).toHaveLength(1);
  expect(bucket.keys("mailboxes/m/messages/del-a/")).toHaveLength(2);

  bucket.failDeletes = true;
  await expect(sweepDeletions(store, bucket as never)).rejects.toThrow();
  expect(store.pendingDeletions(10)).toHaveLength(1);

  bucket.failDeletes = false;
  expect(await sweepDeletions(store, bucket as never)).toBe(false);
  expect(bucket.keys()).toEqual(["mailboxes/m/messages/del-b/raw.eml"]);

  expect(store.deleteForever({ messageIds: [a.messageId] })).toBe(0);
  expect(await sweepDeletions(store, bucket as never)).toBe(false);
  expect(store.getThread(b.threadId)?.messages).toHaveLength(1);
});

test("deleting a thread's last message removes the thread and its references", () => {
  const { messageId, threadId } = store.commit(
    message({ rfcMessageId: "only", references: ["parent"] }),
  );
  store.moveToFolder({ messageIds: [messageId] }, "trash");
  store.deleteForever({ messageIds: [messageId] });
  expect(store.getThread(threadId)).toBeNull();
  expect(store.listThreads({ view: { folder: "trash" } }).threads).toEqual([]);
  expect(db.exec("SELECT * FROM thread_refs").toArray()).toEqual([]);

  const again = store.commit(message({ rfcMessageId: "only" }));
  expect(again.status).toBe("stored");
  expect(store.getThread(again.threadId)?.messages).toHaveLength(1);
});

test("delivering a message again does not cancel the clean-up of its deleted copy", () => {
  const first = store.commit(
    message({ rawHash: "again", r2Prefix: "attempt-1/" }),
  );
  store.moveToFolder({ messageIds: [first.messageId] }, "trash");
  store.deleteForever({ messageIds: [first.messageId] });
  const again = store.commit(
    message({ rawHash: "again", r2Prefix: "attempt-2/" }),
  );
  expect(again.status).toBe("stored");
  expect(store.pendingDeletions(10)).toEqual(["attempt-1/"]);
  expect(store.storagePrefix(again.messageId)).toBe("attempt-2/");
});

test("the copy that loses a duplicate race queues its own objects and nothing else", () => {
  const winner = store.commit(
    message({ rawHash: "race", r2Prefix: "winner/" }),
  );
  const loser = store.commit(message({ rawHash: "race", r2Prefix: "loser/" }));
  expect(loser).toEqual({ ...winner, status: "duplicate" });
  expect(store.pendingDeletions(10)).toEqual(["loser/"]);
  expect(store.storagePrefix(winner.messageId)).toBe("winner/");
});

test("the winner's commit arriving twice does not queue the message's own objects", () => {
  const winner = message({ rawHash: "twice", r2Prefix: "winner/" });
  store.commit(winner);
  expect(store.commit(winner).status).toBe("duplicate");
  expect(store.pendingDeletions(10)).toEqual([]);
});
