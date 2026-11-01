import { expect, test } from "bun:test";
import type { LabelId, MessageId, ThreadId, ThreadSummary } from "../types";
import {
  clearingStep,
  type DeviceOwner,
  emptyLedger,
  fingerprints,
  isOwnerExpired,
  OFFLINE_TRUST_MS,
  savedBytes,
  threadsToFetch,
  threadsToForget,
} from "./offline-model";

const thread = (
  id: number,
  changes: Partial<ThreadSummary> = {},
): ThreadSummary => ({
  id: id as ThreadId,
  subject: "s",
  snippet: "",
  senders: [],
  lastMessageAt: id,
  messageCount: 1,
  unreadCount: 0,
  starred: false,
  hasAttachments: false,
  labelIds: [],
  folders: [],
  ...changes,
});

function ledgerFor(lists: ThreadSummary[][]) {
  const ledger = emptyLedger();
  for (const [id, fingerprint] of fingerprints(lists)) {
    ledger.threads[id] = { fingerprint, messageIds: [] };
  }
  return ledger;
}

test("the first refresh fetches every thread, newest first", () => {
  expect(
    threadsToFetch([[thread(1), thread(3)], [thread(2)]], emptyLedger()),
  ).toEqual([3 as ThreadId, 2 as ThreadId, 1 as ThreadId]);
});

test("a refresh with nothing new fetches nothing", () => {
  const lists = [[thread(1), thread(2)]];
  expect(threadsToFetch(lists, ledgerFor(lists))).toEqual([]);
});

test.each([
  ["a new reply", { messageCount: 2 }],
  ["being read elsewhere", { unreadCount: 1 }],
  ["a star", { starred: true }],
  ["a label", { labelIds: [1 as LabelId] }],
])("%s makes the thread fetch again", (_name, change) => {
  const ledger = ledgerFor([[thread(1), thread(2)]]);
  expect(threadsToFetch([[thread(1, change), thread(2)]], ledger)).toEqual([
    1 as ThreadId,
  ]);
});

test("moving a thread to another folder makes it fetch again", () => {
  const ledger = ledgerFor([[thread(1)], []]);
  expect(threadsToFetch([[], [thread(1)]], ledger)).toEqual([1 as ThreadId]);
});

test("a thread gone from every saved folder is forgotten", () => {
  const ledger = ledgerFor([[thread(1), thread(2)]]);
  expect(threadsToForget([[thread(2)]], ledger)).toEqual([1 as ThreadId]);
});

test("saved size adds up every body", () => {
  const ledger = emptyLedger();
  ledger.bodySizes[1 as MessageId] = 100;
  ledger.bodySizes[2 as MessageId] = 50;
  expect(savedBytes(ledger)).toBe(150);
});

test("saved mail stops opening once its session could have ended", () => {
  const owner = { user: {} as never, verifiedAt: 1000 };
  expect(isOwnerExpired(owner, 1000 + OFFLINE_TRUST_MS)).toBe(false);
  expect(isOwnerExpired(owner, 1001 + OFFLINE_TRUST_MS)).toBe(true);
});

const recent: DeviceOwner = { user: {} as never, verifiedAt: 1000 };
const afterLimit = 1000 + OFFLINE_TRUST_MS + 1;

test.each([
  ["someone still signed in", "signed-in", recent, 1000, "backToMail"],
  [
    "someone still signed in, long unchecked",
    "signed-in",
    recent,
    afterLimit,
    "backToMail",
  ],
  [
    "the server saying nobody is signed in",
    "signed-out",
    recent,
    1000,
    "clearThenSignIn",
  ],
  ["no answer, with a recent check", "unknown", recent, 1000, "askFirst"],
  ["no answer, with nothing saved", "unknown", null, 1000, "askFirst"],
  [
    "no answer, past the time limit",
    "unknown",
    recent,
    afterLimit,
    "clearThenExplain",
  ],
] as const)("the clearing page, for %s", (_name, session, owner, now, step) => {
  expect(clearingStep(session, owner, now)).toBe(step);
});
