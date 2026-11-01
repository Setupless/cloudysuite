import { checkMailboxAccess, type UserId } from "@cloudysuite/access";
import { readSettings } from "../../../../src/settings";
import type { PushMessage } from "./notice";
import {
  type DueDelivery,
  MAX_DELIVERY_ATTEMPTS,
  type PushStore,
} from "./store";
import {
  deleteSubscription,
  devicesForMailbox,
  ensureVapidKeys,
  type SavedSubscription,
  subscriptionsById,
  usersWithLiveSession,
} from "./subscriptions";
import {
  encryptPayload,
  fromBase64Url,
  type VapidKeys,
  vapidAuthorization,
} from "./web-push";

// Each send is one subrequest, and a run also reads D1, so a mailbox with many devices
// spreads over several alarms. A new message cannot add to this: see push_deliveries.
export const MAX_SENDS_PER_RUN = 50;
const PARALLEL_SENDS = 6;
const SEND_TIMEOUT_MS = 10_000;
const NEXT_BATCH_DELAY_MS = 1000;
const FIRST_RETRY_MS = 30_000;
const LONGEST_RETRY_MS = 60 * 60 * 1000;
// A notification about day-old mail is noise, so a push service may drop it by then.
const TIME_TO_LIVE_SECONDS = 24 * 60 * 60;

export type PushJobDeps = {
  database: D1Database;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
};

export type SendOutcome =
  | { kind: "delivered" }
  | { kind: "gone" }
  | { kind: "refused" }
  | { kind: "retry"; afterMs: number | null };

export function outcomeOf(
  status: number,
  retryAfter: string | null,
): SendOutcome {
  if (status >= 200 && status < 300) return { kind: "delivered" };
  if (status === 404 || status === 410) return { kind: "gone" };
  if (status === 429 || status >= 500) {
    const seconds = Number(retryAfter);
    return {
      kind: "retry",
      afterMs: retryAfter && seconds > 0 ? seconds * 1000 : null,
    };
  }
  return { kind: "refused" };
}

async function flushOutbox(
  store: PushStore,
  { database, now }: PushJobDeps,
): Promise<void> {
  const flushAt = now();
  const upTo = store.newestWaitingId();
  if (upTo === null || !store.isFlushDue(flushAt)) return;
  const waiting = store.waitingNotice();
  if (!waiting) {
    store.flush(null, [], upTo, flushAt);
    return;
  }
  const muted = store.mutedUsers();
  const devices = await devicesForMailbox(database, waiting.mailboxId);
  store.flush(
    waiting.notice,
    devices.filter((device) => !muted.has(device.userId)),
    upTo,
    flushAt,
  );
}

// Checked again here, not when the notice was queued: someone removed from the
// mailbox a moment ago must hear nothing more about it.
async function allowedRecipients(
  deliveries: DueDelivery[],
  { database, now }: PushJobDeps,
): Promise<ReadonlySet<UserId>> {
  const userIds = [...new Set(deliveries.map((one) => one.userId))];
  const live = await usersWithLiveSession(database, userIds, now());
  const allowed = new Set<UserId>();
  for (const userId of live) {
    const mailboxId = deliveries.find((one) => one.userId === userId)?.notice
      .mailboxId;
    if (!mailboxId) continue;
    const access = await checkMailboxAccess(database, userId, mailboxId);
    if (access.allowed) allowed.add(userId);
  }
  return allowed;
}

async function send(
  delivery: DueDelivery,
  subscription: SavedSubscription,
  keys: VapidKeys,
  contact: string,
  deps: PushJobDeps,
): Promise<SendOutcome> {
  const message: PushMessage = { ...delivery.notice, to: subscription.userId };
  const body = await encryptPayload(
    new TextEncoder().encode(JSON.stringify(message)),
    {
      p256dh: fromBase64Url(subscription.p256dh),
      auth: fromBase64Url(subscription.auth),
    },
  );
  const response = await deps.fetch(subscription.endpoint, {
    method: "POST",
    body,
    // A redirect could aim the Worker anywhere, so it counts as a refusal. Workers
    // does not accept "error" here.
    redirect: "manual",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    headers: {
      Authorization: await vapidAuthorization(
        subscription.endpoint,
        keys,
        contact,
        deps.now(),
      ),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(TIME_TO_LIVE_SECONDS),
      Urgency: "normal",
    },
  });
  await response.body?.cancel();
  return outcomeOf(response.status, response.headers.get("Retry-After"));
}

function settle(
  store: PushStore,
  delivery: DueDelivery,
  outcome: SendOutcome,
  now: number,
): void {
  if (outcome.kind !== "retry") {
    store.finish(delivery);
    return;
  }
  if (delivery.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) {
    store.finish(delivery);
    return;
  }
  const backoff = FIRST_RETRY_MS * 2 ** delivery.attempts;
  store.retryAt(
    delivery,
    now + Math.min(Math.max(backoff, outcome.afterMs ?? 0), LONGEST_RETRY_MS),
  );
}

async function sendDue(
  store: PushStore,
  primaryDomain: string,
  deps: PushJobDeps,
): Promise<void> {
  const due = store.dueDeliveries(deps.now(), MAX_SENDS_PER_RUN);
  if (due.length === 0) return;
  const [subscriptions, allowed, keys] = await Promise.all([
    subscriptionsById(
      deps.database,
      due.map((one) => one.subscriptionId),
    ),
    allowedRecipients(due, deps),
    ensureVapidKeys(deps.database),
  ]);
  const byId = new Map(subscriptions.map((one) => [one.id, one]));
  const contact = `https://mail.${primaryDomain}`;

  const queue = [...due];
  const worker = async () => {
    for (let delivery = queue.shift(); delivery; delivery = queue.shift()) {
      const subscription = byId.get(delivery.subscriptionId);
      if (!subscription || !allowed.has(subscription.userId)) {
        store.finish(delivery);
        continue;
      }
      if (
        subscription.expiresAt &&
        subscription.expiresAt.getTime() <= deps.now()
      ) {
        await deleteSubscription(deps.database, subscription.id);
        store.finish(delivery);
        continue;
      }
      let outcome: SendOutcome;
      try {
        outcome = await send(delivery, subscription, keys, contact, deps);
      } catch (error) {
        console.error("Could not reach a push service.", error);
        outcome = { kind: "retry", afterMs: null };
      }
      if (outcome.kind === "gone") {
        await deleteSubscription(deps.database, subscription.id);
      }
      if (outcome.kind === "refused") {
        console.error("A push service refused a notification.");
      }
      settle(store, delivery, outcome, deps.now());
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_SENDS }, worker));

  if (store.dueDeliveries(deps.now(), 1).length > 0) {
    store.delayDueDeliveries(deps.now() + NEXT_BATCH_DELAY_MS, deps.now());
  }
}

// Safe to repeat at every step: a row leaves the table only after the push service
// answers, and a resent notice carries the same tag, so a device replaces the
// notification it already shows rather than adding a second.
export async function runDuePush(
  store: PushStore,
  deps: PushJobDeps,
): Promise<void> {
  if (store.nextRunAt() === null) return;
  const { primaryDomain, disabled } = await readSettings(deps.database);
  // Mail keeps arriving while the app is off, and nobody should get a burst of old
  // notifications on the day it comes back.
  if (primaryDomain === null || disabled.has("mail")) {
    store.clear();
    return;
  }
  await flushOutbox(store, deps);
  await sendDue(store, primaryDomain, deps);
}
