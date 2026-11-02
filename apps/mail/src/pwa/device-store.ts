import type { UserId } from "@cloudysuite/access";
import { DEVICE_SESSION_PATH } from "../../../../src/routing";
import type { KeptDraft, KeptNote, OutgoingId } from "../compose/types";
import type { MailboxEntry } from "../functions";
import type {
  MailboxId,
  MessageId,
  ThreadDetail,
  ThreadId,
  ThreadSummary,
} from "../types";
import {
  bodyRecordKey,
  type DeviceOwner,
  emptyLedger,
  listRecordKey,
  type MailboxLedger,
  type SavedBody,
  type SavedBodyEntry,
  threadRecordKey,
} from "./offline-model";

const DATABASE = "cloudysuite-mail";
const CHANNEL = "cloudysuite-mail-device";
const META = "meta";
const LISTS = "lists";
const THREADS = "threads";
const BODIES = "bodies";
const OWNER_KEY = "owner";
const MAILBOXES_KEY = "mailboxes";
const ledgerKey = (mailboxId: MailboxId) => `ledger/${mailboxId}`;
const KEPT_PREFIX = "kept/";
const keptKey = (id: OutgoingId) => `${KEPT_PREFIX}${id}`;
const NOTE_PREFIX = "keptNote/";
const noteKey = (id: OutgoingId) => `${NOTE_PREFIX}${id}`;

// Every person's mail on this device is in this one database and nowhere else: the
// service worker's caches hold only the public build and an anonymous page. So clearing
// this is enough, and nothing about which cache held what needs tracking.
let opening: Promise<IDBDatabase> | null = null;
// A connection already checked for its owner. It stops counting the moment anything starts
// clearing the device, so `keepDraftNow` can't put mail back after a sign-out.
let checked: { database: IDBDatabase; userId: UserId } | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      for (const store of [META, LISTS, THREADS, BODIES]) {
        request.result.createObjectStore(store);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      // Another tab or the service worker is clearing this device. Holding on would
      // block it, and the next use opens a new, empty database.
      database.onversionchange = () => {
        database.close();
        opening = null;
        checked = null;
      };
      database.onclose = () => {
        opening = null;
        checked = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

function requested<Value>(request: IDBRequest<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readOwner(): Promise<DeviceOwner | null> {
  const database = await open();
  const owner = await requested(
    database.transaction(META).objectStore(META).get(OWNER_KEY),
  );
  return (owner as DeviceOwner | undefined) ?? null;
}

// Only one server-checked sign-in may write this. It is what every later write and
// read compares itself against, so a tab that held on to the last person's identity
// finds it no longer matches.
export async function saveOwner(owner: DeviceOwner): Promise<void> {
  const database = await open();
  const transaction = database.transaction(META, "readwrite");
  transaction.objectStore(META).put(owner, OWNER_KEY);
  await finished(transaction);
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

// The owner check and the write share one transaction, so a tab still finishing a
// refresh cannot put the last person's mail back after a sign-out cleared it.
async function writeAsOwner(
  userId: UserId,
  stores: string[],
  write: (transaction: IDBTransaction) => void | Promise<void>,
): Promise<boolean> {
  const database = await open();
  const transaction = database.transaction([META, ...stores], "readwrite");
  const done = finished(transaction);
  const owner = await requested(transaction.objectStore(META).get(OWNER_KEY));
  if ((owner as DeviceOwner | undefined)?.user.id !== userId) {
    transaction.abort();
    await done.catch(() => {});
    return false;
  }
  await write(transaction);
  await done;
  return true;
}

async function readAsOwner<Value>(
  userId: UserId,
  store: string,
  key: string,
): Promise<Value | undefined> {
  const database = await open();
  const transaction = database.transaction([META, store]);
  const [owner, value] = await Promise.all([
    requested(transaction.objectStore(META).get(OWNER_KEY)),
    requested(transaction.objectStore(store).get(key)),
  ]);
  return (owner as DeviceOwner | undefined)?.user.id === userId
    ? (value as Value | undefined)
    : undefined;
}

export const keepDraft = (userId: UserId, draft: KeptDraft) =>
  writeAsOwner(userId, [], (transaction) => {
    transaction.objectStore(META).put(draft, keptKey(draft.id));
  });

export async function getReadyToKeepNow(userId: UserId): Promise<void> {
  if (checked?.userId === userId) return;
  const database = await open();
  const owner = await requested(
    database.transaction(META).objectStore(META).get(OWNER_KEY),
  );
  if ((owner as DeviceOwner | undefined)?.user.id === userId) {
    checked = { database, userId };
  }
}

// For a page that is closing, which gets no later turn for `writeAsOwner` to read the owner
// in. Everything here reaches the browser before this returns, so the write outlives the page.
export function keepDraftNow(userId: UserId, draft: KeptDraft): boolean {
  if (checked?.userId !== userId) return false;
  try {
    const transaction = checked.database.transaction(META, "readwrite");
    transaction.objectStore(META).put(draft, keptKey(draft.id));
    transaction.commit();
    return true;
  } catch {
    return false;
  }
}

async function readAllAsOwner(
  userId: UserId,
  prefix: string,
): Promise<unknown[]> {
  const database = await open();
  const transaction = database.transaction(META);
  const store = transaction.objectStore(META);
  const [owner, rows] = await Promise.all([
    requested(store.get(OWNER_KEY)),
    requested(store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`))),
  ]);
  return (owner as DeviceOwner | undefined)?.user.id === userId ? rows : [];
}

// Unchecked rows: `parseKeptDraft` and `parseKeptNote` decide what they are.
export const readKeptRows = (userId: UserId) =>
  readAllAsOwner(userId, KEPT_PREFIX);

export const readKeptNoteRows = (userId: UserId) =>
  readAllAsOwner(userId, NOTE_PREFIX);

async function forgetVersion(
  store: IDBObjectStore,
  id: OutgoingId,
  keptAt: number,
) {
  const held = (await requested(store.get(keptKey(id)))) as
    KeptDraft | undefined;
  if (held?.keptAt === keptAt) store.delete(keptKey(id));
}

// A copy written since `keptAt`, by another tab or a later keystroke, stays.
export const forgetKeptDraft = (
  userId: UserId,
  id: OutgoingId,
  keptAt: number,
) =>
  writeAsOwner(userId, [], (transaction) =>
    forgetVersion(transaction.objectStore(META), id, keptAt),
  );

// One transaction, so the words can't go without the note about what they lost.
export const settleKeptDraft = (
  userId: UserId,
  id: OutgoingId,
  keptAt: number,
  note: KeptNote | null,
) =>
  writeAsOwner(userId, [], async (transaction) => {
    const store = transaction.objectStore(META);
    if (note) store.put(note, noteKey(note.id));
    await forgetVersion(store, id, keptAt);
  });

export const keepNote = (userId: UserId, note: KeptNote) =>
  writeAsOwner(userId, [], (transaction) => {
    transaction.objectStore(META).put(note, noteKey(note.id));
  });

export const forgetKeptNote = (userId: UserId, id: OutgoingId) =>
  writeAsOwner(userId, [], (transaction) => {
    transaction.objectStore(META).delete(noteKey(id));
  });

export const readSavedMailboxes = (userId: UserId) =>
  readAsOwner<MailboxEntry[]>(userId, META, MAILBOXES_KEY);

export const readSavedList = (
  userId: UserId,
  mailboxId: MailboxId,
  view: string,
) =>
  readAsOwner<ThreadSummary[]>(userId, LISTS, listRecordKey(mailboxId, view));

export const readSavedThread = (
  userId: UserId,
  mailboxId: MailboxId,
  threadId: ThreadId,
) =>
  readAsOwner<ThreadDetail>(
    userId,
    THREADS,
    threadRecordKey(mailboxId, threadId),
  );

export const readSavedBody = (
  userId: UserId,
  mailboxId: MailboxId,
  messageId: MessageId,
) =>
  readAsOwner<SavedBody>(userId, BODIES, bodyRecordKey(mailboxId, messageId));

export async function readLedger(
  userId: UserId,
  mailboxId: MailboxId,
): Promise<MailboxLedger> {
  return (
    (await readAsOwner<MailboxLedger>(userId, META, ledgerKey(mailboxId))) ??
    emptyLedger()
  );
}

export const saveMailboxes = (userId: UserId, mailboxes: MailboxEntry[]) =>
  writeAsOwner(userId, [], (transaction) => {
    transaction.objectStore(META).put(mailboxes, MAILBOXES_KEY);
  });

export const saveLists = (
  userId: UserId,
  mailboxId: MailboxId,
  lists: readonly (readonly [
    view: string,
    threads: readonly ThreadSummary[],
  ])[],
) =>
  writeAsOwner(userId, [LISTS], (transaction) => {
    const store = transaction.objectStore(LISTS);
    for (const [view, threads] of lists) {
      store.put(threads, listRecordKey(mailboxId, view));
    }
  });

function bodySize(entry: SavedBodyEntry): number {
  return entry.state === "saved" ? JSON.stringify(entry.body).length : 0;
}

export function saveBatch(
  userId: UserId,
  mailboxId: MailboxId,
  threads: readonly { detail: ThreadDetail; fingerprint: string | null }[],
  bodies: readonly SavedBodyEntry[],
): Promise<boolean> {
  return writeAsOwner(userId, [THREADS, BODIES], async (transaction) => {
    const meta = transaction.objectStore(META);
    const ledger =
      ((await requested(meta.get(ledgerKey(mailboxId)))) as
        MailboxLedger | undefined) ?? emptyLedger();
    for (const { detail, fingerprint } of threads) {
      transaction
        .objectStore(THREADS)
        .put(detail, threadRecordKey(mailboxId, detail.id));
      // No fingerprint means a body is still missing, so the next refresh returns here.
      ledger.threads[detail.id] = {
        fingerprint: fingerprint ?? "",
        messageIds: detail.messages.map((message) => message.id),
      };
    }
    for (const entry of bodies) {
      const { messageId, ...body } = entry;
      transaction
        .objectStore(BODIES)
        .put(body, bodyRecordKey(mailboxId, messageId));
      ledger.bodySizes[messageId] = bodySize(entry);
    }
    meta.put(ledger, ledgerKey(mailboxId));
  });
}

export function forgetThreads(
  userId: UserId,
  mailboxId: MailboxId,
  threadIds: readonly ThreadId[],
): Promise<boolean> {
  return writeAsOwner(userId, [THREADS, BODIES], async (transaction) => {
    const meta = transaction.objectStore(META);
    const ledger =
      ((await requested(meta.get(ledgerKey(mailboxId)))) as
        MailboxLedger | undefined) ?? emptyLedger();
    for (const threadId of threadIds) {
      for (const messageId of ledger.threads[threadId]?.messageIds ?? []) {
        transaction
          .objectStore(BODIES)
          .delete(bodyRecordKey(mailboxId, messageId));
        delete ledger.bodySizes[messageId];
      }
      transaction
        .objectStore(THREADS)
        .delete(threadRecordKey(mailboxId, threadId));
      delete ledger.threads[threadId];
    }
    meta.put(ledger, ledgerKey(mailboxId));
  });
}

// For a mailbox this person can no longer open.
export function forgetMailbox(
  userId: UserId,
  mailboxId: MailboxId,
): Promise<boolean> {
  return writeAsOwner(userId, [LISTS, THREADS, BODIES], (transaction) => {
    const range = IDBKeyRange.bound(`${mailboxId}/`, `${mailboxId}/￿`);
    for (const store of [LISTS, THREADS, BODIES]) {
      transaction.objectStore(store).delete(range);
    }
    transaction.objectStore(META).delete(ledgerKey(mailboxId));
  });
}

export async function savedMailboxIds(userId: UserId): Promise<MailboxId[]> {
  const database = await open();
  const keys = await requested(
    database
      .transaction(META)
      .objectStore(META)
      .getAllKeys(IDBKeyRange.bound("ledger/", "ledger/￿")),
  );
  const owner = await readOwner();
  if (owner?.user.id !== userId) return [];
  return keys.map((key) => String(key).slice("ledger/".length) as MailboxId);
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function registrations(): Promise<readonly ServiceWorkerRegistration[]> {
  if ("registration" in globalThis) {
    return [
      (globalThis as unknown as { registration: ServiceWorkerRegistration })
        .registration,
    ];
  }
  return "serviceWorker" in navigator
    ? navigator.serviceWorker.getRegistrations()
    : [];
}

// Everything this device holds for Mail, whichever context notices that it has to go:
// a page, the service worker, or the page sign-out passes through. One step failing
// must not stop the rest. A later visit installs the service worker again.
export async function clearDevice(): Promise<void> {
  const held = await registrations().catch(() => []);
  await Promise.allSettled(
    held.map(async (registration) => {
      const subscription = await registration.pushManager.getSubscription();
      await subscription?.unsubscribe();
    }),
  );
  const heldOpen = opening;
  opening = null;
  checked = null;
  await heldOpen?.then((database) => database.close()).catch(() => {});
  await Promise.allSettled([
    deleteDatabase(),
    caches
      .keys()
      .then((names) => Promise.all(names.map((name) => caches.delete(name)))),
  ]);
  await Promise.allSettled(
    held.map((registration) => registration.unregister()),
  );
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage("cleared");
  channel.close();
}

export function onDeviceCleared(run: () => void): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = run;
  return () => channel.close();
}

export type ServerSession =
  | { kind: "signed-in"; userId: UserId }
  | { kind: "signed-out" }
  | { kind: "unknown" };

// `unknown` covers no connection and a server error. Neither says this person has gone.
export async function readServerSession(): Promise<ServerSession> {
  try {
    const response = await fetch(DEVICE_SESSION_PATH, {
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 401) return { kind: "signed-out" };
    if (!response.ok) return { kind: "unknown" };
    const { userId } = (await response.json()) as { userId: UserId };
    return { kind: "signed-in", userId };
  } catch {
    return { kind: "unknown" };
  }
}
