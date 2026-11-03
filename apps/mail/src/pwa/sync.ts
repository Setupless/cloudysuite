import type { UserId } from "@cloudysuite/access";
import { isAppOffRefusal } from "../../../../src/routing";
import { listMailboxes, listThreads } from "../functions";
import type { MailboxId, ThreadId, ThreadSummary } from "../types";
import {
  clearDevice,
  forgetMailbox,
  forgetThreads,
  readLedger,
  saveBatch,
  saveLists,
  saveMailboxes,
  savedMailboxIds,
} from "./device-store";
import { getSavedThreadBatch } from "./functions";
import {
  fingerprints,
  MAX_SAVED_BYTES_PER_MAILBOX,
  SAVED_THREADS_PER_FOLDER,
  savedBytes,
  THREADS_PER_BATCH,
  threadsToFetch,
  threadsToForget,
} from "./offline-model";

const LIST_PAGE_SIZE = 100;
const SYNC_LOCK = "cloudysuite-mail-sync";

const FOLDER_LIMITS = Object.entries(SAVED_THREADS_PER_FOLDER) as [
  keyof typeof SAVED_THREADS_PER_FOLDER,
  number,
][];

async function readFolder(
  mailboxId: MailboxId,
  folder: (typeof FOLDER_LIMITS)[number][0],
  limit: number,
): Promise<ThreadSummary[]> {
  const threads: ThreadSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await listThreads({
      data: {
        mailboxId,
        view: { folder },
        cursor,
        limit: Math.min(LIST_PAGE_SIZE, limit - threads.length),
      },
    });
    threads.push(...page.threads);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && threads.length < limit);
  return threads;
}

async function saveMailbox(userId: UserId, mailboxId: MailboxId) {
  const lists = await Promise.all(
    FOLDER_LIMITS.map(([folder, limit]) =>
      readFolder(mailboxId, folder, limit),
    ),
  );
  const accepted = await saveLists(
    userId,
    mailboxId,
    FOLDER_LIMITS.map(([folder], index) => [folder, lists[index] ?? []]),
  );
  if (!accepted) return;

  let ledger = await readLedger(userId, mailboxId);
  const stale = threadsToForget(lists, ledger);
  if (stale.length > 0) await forgetThreads(userId, mailboxId, stale);

  const wanted = fingerprints(lists);
  const queue: ThreadId[] = threadsToFetch(lists, ledger);
  while (queue.length > 0) {
    ledger = await readLedger(userId, mailboxId);
    if (savedBytes(ledger) >= MAX_SAVED_BYTES_PER_MAILBOX) return;
    const threadIds = queue.splice(0, THREADS_PER_BATCH);
    const haveBodies = threadIds
      .flatMap((id) => ledger.threads[id]?.messageIds ?? [])
      .filter((messageId) => ledger.bodySizes[messageId] !== undefined);
    const batch = await getSavedThreadBatch({
      data: { mailboxId, threadIds, haveBodies },
    });
    const received = new Set([
      ...haveBodies,
      ...batch.bodies.map((entry) => entry.messageId),
    ]);
    const stillOwner = await saveBatch(
      userId,
      mailboxId,
      batch.threads.map((detail) => ({
        detail,
        fingerprint: detail.messages.every((message) =>
          received.has(message.id),
        )
          ? (wanted.get(detail.id) ?? null)
          : null,
      })),
      batch.bodies,
    );
    if (!stillOwner) return;
  }
}

// Each failed mailbox waits for the next refresh and leaves the rest alone. A refusal
// means this person can no longer open it, so what is saved has to go. Mail being
// turned off ends the refresh instead, because turning it back on restores the device.
async function refreshDevice(userId: UserId): Promise<void> {
  const mailboxes = await listMailboxes();
  if (!(await saveMailboxes(userId, mailboxes))) return;
  const current = new Set<MailboxId>(mailboxes.map((mailbox) => mailbox.id));
  for (const mailboxId of await savedMailboxIds(userId)) {
    if (!current.has(mailboxId)) await forgetMailbox(userId, mailboxId);
  }
  for (const { id } of mailboxes) {
    try {
      await saveMailbox(userId, id);
    } catch (thrown) {
      if (isAppOffRefusal(thrown, "mail")) throw thrown;
      if (thrown instanceof Response && thrown.status === 403) {
        await forgetMailbox(userId, id);
      } else if (thrown instanceof Response && thrown.status === 401) {
        throw thrown;
      } else {
        console.error("Could not save a mailbox for offline reading.", thrown);
      }
    }
  }
}

// One tab at a time, because a second would download the same mail for nothing.
export async function saveMailForOffline(userId: UserId): Promise<void> {
  const run = async () => {
    try {
      await refreshDevice(userId);
    } catch (thrown) {
      if (thrown instanceof Response && thrown.status === 401) {
        await clearDevice();
        location.reload();
        return;
      }
      console.error("Could not save mail for offline reading.", thrown);
    }
  };
  if (!("locks" in navigator)) return run();
  await navigator.locks.request(SYNC_LOCK, { ifAvailable: true }, (lock) =>
    lock ? run() : undefined,
  );
}
