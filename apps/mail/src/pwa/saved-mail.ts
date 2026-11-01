import type { UserId } from "@cloudysuite/access";
import { NotSavedOnDevice } from "../failure";
import { viewParam } from "../model";
import type { SearchPage } from "../search/store";
import type {
  MailboxId,
  MessageId,
  ThreadId,
  ThreadPage,
  ThreadView,
} from "../types";
import {
  isConnectionFailure,
  isOffline,
  markReachable,
  markUnreachable,
} from "./connectivity";
import {
  readSavedBody,
  readSavedList,
  readSavedMailboxes,
  readSavedThread,
} from "./device-store";

let reader: UserId | null = null;

// Set once this tab knows who it is showing mail to. No reader, no saved mail.
export function setSavedMailReader(userId: UserId | null): void {
  reader = userId;
}

const FOLDER_NOT_SAVED =
  "You're offline, and this folder isn't saved on this device. It will come back when you reconnect.";
const LABEL_NOT_SAVED =
  "You're offline, and labels aren't saved on this device. They will come back when you reconnect.";
const SEARCH_NOT_SAVED =
  "You're offline, so search isn't available. It will come back when you reconnect.";
const RULES_NOT_SAVED =
  "You're offline, and rules aren't saved on this device. They will come back when you reconnect.";
const THREAD_NOT_SAVED =
  "You're offline, and this conversation isn't saved on this device. It will come back when you reconnect.";
const BODY_NOT_SAVED =
  "You're offline, and this message isn't saved on this device. It may be too large, or it may not have been saved yet.";
const NOTHING_SAVED =
  "You're offline, and no mail is saved on this device yet. Connect to the internet and try again.";

// The server first, whenever it might answer: a saved copy is only ever a stand-in. Any
// answer from the server, refusals included, is the truth and goes back to the caller.
async function readThrough<Result>(
  fromServer: () => Promise<Result>,
  fromDevice: (userId: UserId) => Promise<Result | undefined>,
  missing: string,
): Promise<Result> {
  if (import.meta.env.SSR) return fromServer();
  if (navigator.onLine) {
    try {
      const result = await fromServer();
      markReachable();
      return result;
    } catch (thrown) {
      if (!isConnectionFailure(thrown)) {
        markReachable();
        throw thrown;
      }
      markUnreachable();
    }
  }
  const saved = reader ? await fromDevice(reader) : undefined;
  if (saved === undefined) throw new NotSavedOnDevice(missing);
  return saved;
}

export const readMailboxes = <Result>(fromServer: () => Promise<Result>) =>
  readThrough(
    fromServer,
    (userId) => readSavedMailboxes(userId) as Promise<Result | undefined>,
    NOTHING_SAVED,
  );

// One page holding everything saved. A cursor from here would mean nothing to the
// server after reconnecting.
export const readThreadPage = (
  fromServer: () => Promise<ThreadPage>,
  mailboxId: MailboxId,
  view: ThreadView,
) =>
  readThrough<SearchPage>(
    async () => ({ ...(await fromServer()), problem: null }),
    async (userId) => {
      const threads = await readSavedList(userId, mailboxId, viewParam(view));
      return threads && { threads, nextCursor: null, problem: null };
    },
    "labelId" in view ? LABEL_NOT_SAVED : FOLDER_NOT_SAVED,
  );

const nothingSaved = async () => undefined;

export const readSearchPage = (fromServer: () => Promise<SearchPage>) =>
  readThrough(fromServer, nothingSaved, SEARCH_NOT_SAVED);

export const readRules = <Result>(fromServer: () => Promise<Result>) =>
  readThrough(fromServer, nothingSaved, RULES_NOT_SAVED);

export const readThread = <Result>(
  fromServer: () => Promise<Result>,
  mailboxId: MailboxId,
  threadId: ThreadId,
) =>
  readThrough(
    fromServer,
    (userId) =>
      readSavedThread(userId, mailboxId, threadId) as Promise<
        Result | undefined
      >,
    THREAD_NOT_SAVED,
  );

export const readBody = <Result>(
  fromServer: () => Promise<Result>,
  mailboxId: MailboxId,
  messageId: MessageId,
) =>
  readThrough(
    fromServer,
    async (userId) => {
      const saved = await readSavedBody(userId, mailboxId, messageId);
      return saved?.state === "saved" ? (saved.body as Result) : undefined;
    },
    BODY_NOT_SAVED,
  );

export const readFirstMailbox = (fromServer: () => Promise<MailboxId | null>) =>
  readThrough(
    fromServer,
    async (userId) => {
      const mailboxes = await readSavedMailboxes(userId);
      return mailboxes && (mailboxes[0]?.id ?? null);
    },
    NOTHING_SAVED,
  );

export const OFFLINE_ACTION_REFUSED =
  "You're offline, so nothing changed. Try again when you're back online.";

export { isOffline };
