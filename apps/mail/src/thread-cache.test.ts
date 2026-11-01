import { expect, test } from "bun:test";
import type { MailboxEntry } from "./functions";
import {
  patchFlagsInDetail,
  patchLabelInDetail,
  patchLabelInPages,
  patchFlagsInPages,
  removeFromPages,
  summaryAfterFlags,
  summaryAfterMove,
  type ThreadPages,
  threadsIn,
} from "./thread-cache";
import type {
  LabelId,
  MailboxId,
  ThreadDetail,
  ThreadId,
  ThreadSummary,
} from "./types";

const mailboxId = "m" as MailboxId;
const row = (id: number, unreadCount = 0): ThreadSummary => ({
  id: id as ThreadId,
  subject: `s${id}`,
  snippet: "",
  senders: [],
  lastMessageAt: id,
  messageCount: 2,
  unreadCount,
  starred: false,
  hasAttachments: false,
  folders: ["inbox"],
  labelIds: [],
});
const pages = (...rows: ThreadSummary[][]): ThreadPages => ({
  pageParams: rows.map(() => undefined),
  pages: rows.map((threads) => ({ threads, nextCursor: null })),
});
const entry = (inbox: number, archive = 0): MailboxEntry =>
  ({
    id: mailboxId,
    summary: {
      folderUnread: { inbox, archive, sent: 0, drafts: 0, spam: 0, trash: 0 },
      labels: [{ id: 7 as LabelId, name: "x", unread: 1 }],
    },
  }) as MailboxEntry;
const unreadInbox = (entries: MailboxEntry[]) =>
  entries[0]!.summary.folderUnread.inbox;

test("marking a row read and unread updates only that row, on any page", () => {
  const before = pages([row(1, 1)], [row(2, 2)]);
  const read = patchFlagsInPages(before, 2 as ThreadId, { read: true });
  expect(threadsIn(read).map((one) => one.unreadCount)).toEqual([1, 0]);
  const unread = patchFlagsInPages(read, 2 as ThreadId, { read: false });
  expect(threadsIn(unread).map((one) => one.unreadCount)).toEqual([1, 2]);
  expect(threadsIn(before).map((one) => one.unreadCount)).toEqual([1, 2]);
});

test("a star changes the star and leaves the unread mark alone", () => {
  const [changed] = threadsIn(
    patchFlagsInPages(pages([row(1, 1)]), 1 as ThreadId, { starred: true }),
  );
  expect(changed).toMatchObject({ starred: true, unreadCount: 1 });
});

test("moving a conversation takes it out of the list and keeps the others in order", () => {
  const after = removeFromPages(
    pages([row(1), row(2)], [row(3)]),
    2 as ThreadId,
  );
  expect(threadsIn(after).map((one) => one.id as number)).toEqual([1, 3]);
});

test("the open conversation's messages follow the same flags", () => {
  const detail = {
    id: 1,
    messages: [
      { read: false, starred: false },
      { read: true, starred: true },
    ],
  } as ThreadDetail;
  expect(
    patchFlagsInDetail(detail, { read: true }).messages.map((one) => one.read),
  ).toEqual([true, true]);
  expect(
    patchFlagsInDetail(detail, { starred: false }).messages.map(
      (one) => one.starred,
    ),
  ).toEqual([false, false]);
});

test("the sidebar count moves only when a whole conversation changes", () => {
  const inbox = { folder: "inbox" } as const;
  const after = (wasUnread: boolean, read: boolean) =>
    unreadInbox(
      summaryAfterFlags([entry(3)], mailboxId, inbox, wasUnread, read),
    );
  expect(after(true, true)).toBe(2);
  expect(after(false, false)).toBe(4);
  expect(after(true, false)).toBe(3);
  expect(after(false, true)).toBe(3);
  expect(
    summaryAfterFlags(
      [entry(0)],
      mailboxId,
      { labelId: 7 as LabelId },
      true,
      true,
    )[0]!.summary.labels[0]!.unread,
  ).toBe(0);
  expect(
    unreadInbox(summaryAfterFlags([entry(0)], mailboxId, inbox, true, true)),
  ).toBe(0);
});

test("an unread conversation that moves takes its count with it", () => {
  const moved = summaryAfterMove(
    [entry(3, 1)],
    mailboxId,
    "inbox",
    "archive",
    true,
  );
  expect(moved[0]!.summary.folderUnread).toMatchObject({
    inbox: 2,
    archive: 2,
  });
  const read = summaryAfterMove(
    [entry(3, 1)],
    mailboxId,
    "inbox",
    "archive",
    false,
  );
  expect(read[0]!.summary.folderUnread).toMatchObject({ inbox: 3, archive: 1 });
  const gone = summaryAfterMove(
    [entry(3)],
    mailboxId,
    "inbox",
    "deleteForever",
    true,
  );
  expect(gone[0]!.summary.folderUnread.inbox).toBe(2);
});

test("a label shows on a row and in a thread at once, and comes off", () => {
  const label = 7 as LabelId;
  const pages = {
    pages: [{ threads: [row(1), row(2)], nextCursor: null }],
    pageParams: [undefined],
  };
  const on = patchLabelInPages(pages, 1 as ThreadId, label, true);
  expect(on.pages[0]!.threads.map((thread) => thread.labelIds)).toEqual([
    [label],
    [],
  ]);
  const off = patchLabelInPages(on, 1 as ThreadId, label, false);
  expect(off.pages[0]!.threads[0]!.labelIds).toEqual([]);

  const detail = {
    id: 1 as ThreadId,
    messages: [{ labelIds: [] as LabelId[] }, { labelIds: [label] }],
  } as ThreadDetail;
  const patched = patchLabelInDetail(detail, label, true);
  expect(patched.messages.map((message) => message.labelIds)).toEqual([
    [label],
    [label],
  ]);
});
