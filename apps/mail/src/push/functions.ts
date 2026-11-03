import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { mailboxAccess, mailboxes } from "../../../../src/db/schema";
import { openMailboxAs, openMailboxFor, requireMailUser } from "../access";
import type { MailboxId } from "../types";
import { badRequest, requireMailboxId } from "../wire";
import { parsePushEndpoint } from "./endpoint";
import {
  ensureVapidKeys,
  isSubscribed,
  removeSubscription,
  saveSubscription,
} from "./subscriptions";
import { fromBase64Url } from "./web-push";

export type MailboxNotifications = {
  id: MailboxId;
  name: string;
  enabled: boolean;
};

export type PushSetup = {
  publicKey: string;
  subscribed: boolean;
  mailboxes: MailboxNotifications[];
};

const MAX_USER_AGENT_LENGTH = 200;

const record = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) throw badRequest();
  return raw as Record<string, unknown>;
};

function requireEndpoint(raw: unknown): string {
  const endpoint = typeof raw === "string" ? parsePushEndpoint(raw) : null;
  if (!endpoint) throw badRequest();
  return endpoint;
}

function requireKey(raw: unknown, bytes: number): string {
  if (typeof raw !== "string") throw badRequest();
  let decoded: Uint8Array;
  try {
    decoded = fromBase64Url(raw);
  } catch {
    throw badRequest();
  }
  if (decoded.length !== bytes) throw badRequest();
  return raw;
}

function parseSubscribeInput(raw: unknown) {
  const input = record(raw);
  const { expirationTime } = input;
  if (
    expirationTime !== null &&
    expirationTime !== undefined &&
    (typeof expirationTime !== "number" ||
      !Number.isSafeInteger(expirationTime))
  ) {
    throw badRequest();
  }
  return {
    endpoint: requireEndpoint(input.endpoint),
    p256dh: requireKey(input.p256dh, 65),
    auth: requireKey(input.auth, 16),
    expiresAt: expirationTime ? new Date(expirationTime) : null,
  };
}

// The first call anywhere creates the organisation's keys. Setup does not need them,
// and a deployment nobody turns notifications on for never makes them.
export const getPushSetup = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const { endpoint } = record(raw);
    // A browser holding a subscription we no longer accept just counts as not on.
    return {
      endpoint:
        typeof endpoint === "string" ? parsePushEndpoint(endpoint) : null,
    };
  })
  .handler(async ({ data }): Promise<PushSetup> => {
    const user = await requireMailUser(getRequest());
    const [{ publicKey }, subscribed, rows] = await Promise.all([
      ensureVapidKeys(env.DB),
      data.endpoint
        ? isSubscribed(env.DB, user.id, data.endpoint)
        : Promise.resolve(false),
      drizzle(env.DB)
        .select({ id: mailboxes.id, name: mailboxes.name })
        .from(mailboxAccess)
        .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
        .where(eq(mailboxAccess.userId, user.id))
        .orderBy(asc(mailboxes.kind), asc(mailboxes.name)),
    ]);
    return {
      publicKey,
      subscribed,
      mailboxes: await Promise.all(
        rows.map(async (row) => ({
          ...row,
          enabled: !(await (await openMailboxAs(user.id, row.id)).pushMuted()),
        })),
      ),
    };
  });

export const subscribePush = createServerFn({ method: "POST" })
  .validator(parseSubscribeInput)
  .handler(async ({ data }): Promise<void> => {
    const request = getRequest();
    const user = await requireMailUser(request);
    await saveSubscription(env.DB, user.id, {
      ...data,
      userAgent:
        request.headers.get("User-Agent")?.slice(0, MAX_USER_AGENT_LENGTH) ??
        null,
    });
  });

export const unsubscribePush = createServerFn({ method: "POST" })
  .validator((raw: unknown) => ({
    endpoint: requireEndpoint(record(raw).endpoint),
  }))
  .handler(async ({ data }): Promise<void> => {
    const user = await requireMailUser(getRequest());
    await removeSubscription(env.DB, user.id, data.endpoint);
  });

export const setMailboxNotifications = createServerFn({ method: "POST" })
  .validator((raw: unknown) => {
    const input = record(raw);
    if (typeof input.enabled !== "boolean") throw badRequest();
    return {
      mailboxId: requireMailboxId(input.mailboxId),
      enabled: input.enabled,
    };
  })
  .handler(async ({ data }): Promise<void> => {
    const mailbox = await openMailboxFor(getRequest(), data.mailboxId);
    await mailbox.setPushMuted(!data.enabled);
  });
