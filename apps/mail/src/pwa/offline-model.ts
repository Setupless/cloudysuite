import type { SignedIn } from "@cloudysuite/auth/session";
import type { RenderedBody } from "../email/render-body";
import type {
  Folder,
  MailboxId,
  MessageId,
  ThreadDetail,
  ThreadId,
  ThreadSummary,
} from "../types";

// What one mailbox keeps on a device. Spam and Trash stay out: they are what a person
// least needs on a train, and Spam is where the most hostile mail sits.
export const SAVED_THREADS_PER_FOLDER: Partial<Record<Folder, number>> = {
  inbox: 300,
  sent: 100,
  archive: 100,
};
export const MAX_SAVED_BODY_BYTES = 256 * 1024;
export const MAX_SAVED_BYTES_PER_MAILBOX = 50 * 1024 * 1024;
export const THREADS_PER_BATCH = 20;
export const MAX_BODIES_PER_BATCH = 40;
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;

// No check can reach the server while offline, so saved mail stops opening once the
// session it came from could have ended: Better Auth's default session lasts 7 days.
export const OFFLINE_TRUST_MS = 7 * 24 * 60 * 60 * 1000;

export type DeviceOwner = { user: SignedIn; verifiedAt: number };

export type ServerSessionKind = "signed-in" | "signed-out" | "unknown";

export type SavedBody =
  { state: "saved"; body: RenderedBody | null } | { state: "tooLarge" };

export type SavedBodyEntry = SavedBody & { messageId: MessageId };

export type SavedThreadBatch = {
  threads: ThreadDetail[];
  bodies: SavedBodyEntry[];
};

// The saved records of one mailbox, summed up, so a refresh can tell what changed
// without reading every message back out of IndexedDB.
export type MailboxLedger = {
  threads: Record<number, { fingerprint: string; messageIds: MessageId[] }>;
  bodySizes: Record<number, number>;
};

export const emptyLedger = (): MailboxLedger => ({
  threads: {},
  bodySizes: {},
});

export const isOwnerExpired = (owner: DeviceOwner, now: number): boolean =>
  now - owner.verifiedAt > OFFLINE_TRUST_MS;

export type ClearingStep =
  "backToMail" | "clearThenSignIn" | "clearThenExplain" | "askFirst";

// What `/device-cleared` does. Anyone can link to that page, so only facts a link cannot
// fake may clear anything: the server saying nobody is signed in, or this device's own
// record passing its time limit. Anything else waits for a click.
export function clearingStep(
  session: ServerSessionKind,
  owner: DeviceOwner | null,
  now: number,
): ClearingStep {
  if (session === "signed-in") return "backToMail";
  if (session === "signed-out") return "clearThenSignIn";
  return owner && isOwnerExpired(owner, now) ? "clearThenExplain" : "askFirst";
}

// A thread sits in one row per folder, each with that folder's own counts.
export function fingerprints(
  lists: readonly (readonly ThreadSummary[])[],
): Map<ThreadId, string> {
  const parts = new Map<ThreadId, string[]>();
  lists.forEach((threads, list) => {
    for (const thread of threads) {
      const row = `${list}:${thread.lastMessageAt}:${thread.messageCount}:${thread.unreadCount}:${thread.starred}:${thread.labelIds.join()}`;
      parts.set(thread.id, [...(parts.get(thread.id) ?? []), row]);
    }
  });
  return new Map(
    [...parts].map(([threadId, rows]) => [threadId, rows.join("|")]),
  );
}

// Newest first, so a mailbox that hits its size limit keeps the mail most likely wanted.
export function threadsToFetch(
  lists: readonly (readonly ThreadSummary[])[],
  ledger: MailboxLedger,
): ThreadId[] {
  const current = fingerprints(lists);
  const newest = new Map<ThreadId, number>();
  for (const thread of lists.flat()) {
    newest.set(
      thread.id,
      Math.max(newest.get(thread.id) ?? 0, thread.lastMessageAt),
    );
  }
  return [...current]
    .filter(
      ([threadId, fingerprint]) =>
        ledger.threads[threadId]?.fingerprint !== fingerprint,
    )
    .map(([threadId]) => threadId)
    .sort((a, b) => (newest.get(b) ?? 0) - (newest.get(a) ?? 0));
}

export const savedBytes = (ledger: MailboxLedger): number =>
  Object.values(ledger.bodySizes).reduce((total, size) => total + size, 0);

export function threadsToForget(
  lists: readonly (readonly ThreadSummary[])[],
  ledger: MailboxLedger,
): ThreadId[] {
  const kept = new Set<number>(lists.flat().map((thread) => thread.id));
  return Object.keys(ledger.threads)
    .map(Number)
    .filter((threadId) => !kept.has(threadId)) as ThreadId[];
}

export const threadRecordKey = (mailboxId: MailboxId, threadId: ThreadId) =>
  `${mailboxId}/${threadId}`;
export const bodyRecordKey = (mailboxId: MailboxId, messageId: MessageId) =>
  `${mailboxId}/${messageId}`;
export const listRecordKey = (mailboxId: MailboxId, view: string) =>
  `${mailboxId}/${view}`;
