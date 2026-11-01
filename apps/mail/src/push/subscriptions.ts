import type { MailboxId, UserId } from "@cloudysuite/access";
import { and, asc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  mailboxAccess,
  orgSettings,
  pushSubscriptions,
  session,
} from "../../../../src/db/schema";
import { generateVapidKeys, type VapidKeys } from "./web-push";

export type DeviceSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  expiresAt: Date | null;
};

export type SavedSubscription = {
  id: string;
  userId: UserId;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiresAt: Date | null;
};

// Enough for a phone, a tablet, and several computers. A signed-in person can post
// endpoints at will, so this also stops them from growing every later fan-out.
export const MAX_DEVICES_PER_PERSON = 10;

// One statement, so two first uses at the same moment cannot store different keys:
// whichever runs second finds the keys there and gets those back.
export async function ensureVapidKeys(
  database: D1Database,
): Promise<VapidKeys> {
  const db = drizzle(database);
  const [saved] = await db
    .select({
      publicKey: orgSettings.vapidPublicKey,
      privateKey: orgSettings.vapidPrivateKey,
    })
    .from(orgSettings);
  if (saved?.publicKey && saved.privateKey) {
    return { publicKey: saved.publicKey, privateKey: saved.privateKey };
  }
  const fresh = await generateVapidKeys();
  const [row] = await db
    .insert(orgSettings)
    .values({
      id: 1,
      vapidPublicKey: fresh.publicKey,
      vapidPrivateKey: fresh.privateKey,
    })
    .onConflictDoUpdate({
      target: orgSettings.id,
      set: {
        vapidPublicKey: sql`CASE WHEN ${orgSettings.vapidPrivateKey} IS NULL THEN excluded.vapid_public_key ELSE ${orgSettings.vapidPublicKey} END`,
        vapidPrivateKey: sql`COALESCE(${orgSettings.vapidPrivateKey}, excluded.vapid_private_key)`,
      },
    })
    .returning({
      publicKey: orgSettings.vapidPublicKey,
      privateKey: orgSettings.vapidPrivateKey,
    });
  return { publicKey: row?.publicKey ?? "", privateKey: row?.privateKey ?? "" };
}

// An endpoint belongs to one browser profile. If someone else used that profile
// before, it moves to the person signed in now, and the earlier person stops
// receiving notifications there.
export async function saveSubscription(
  database: D1Database,
  userId: UserId,
  device: DeviceSubscription,
): Promise<void> {
  const db = drizzle(database);
  await db
    .insert(pushSubscriptions)
    .values({ userId, ...device })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: device.p256dh,
        auth: device.auth,
        userAgent: device.userAgent,
        expiresAt: device.expiresAt,
      },
    });
  const keep = db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(sql`${pushSubscriptions.createdAt} DESC`)
    .limit(MAX_DEVICES_PER_PERSON);
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        notInArray(pushSubscriptions.id, keep),
      ),
    );
}

export async function removeSubscription(
  database: D1Database,
  userId: UserId,
  endpoint: string,
): Promise<void> {
  await drizzle(database)
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    );
}

export async function isSubscribed(
  database: D1Database,
  userId: UserId,
  endpoint: string,
): Promise<boolean> {
  const rows = await drizzle(database)
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    );
  return rows.length > 0;
}

export async function devicesForMailbox(
  database: D1Database,
  mailboxId: MailboxId,
) {
  return drizzle(database)
    .select({
      subscriptionId: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
    })
    .from(pushSubscriptions)
    .innerJoin(
      mailboxAccess,
      eq(mailboxAccess.userId, pushSubscriptions.userId),
    )
    .where(eq(mailboxAccess.mailboxId, mailboxId))
    .orderBy(asc(pushSubscriptions.id));
}

export async function subscriptionsById(
  database: D1Database,
  ids: string[],
): Promise<SavedSubscription[]> {
  if (ids.length === 0) return [];
  return drizzle(database)
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      expiresAt: pushSubscriptions.expiresAt,
    })
    .from(pushSubscriptions)
    .where(inArray(pushSubscriptions.id, ids));
}

export async function deleteSubscription(
  database: D1Database,
  id: string,
): Promise<void> {
  await drizzle(database)
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.id, id));
}

// A person with no live session has signed out everywhere or been reset, so their
// devices may now be in someone else's hands.
export async function usersWithLiveSession(
  database: D1Database,
  userIds: UserId[],
  now: number,
): Promise<ReadonlySet<UserId>> {
  if (userIds.length === 0) return new Set();
  const rows = await drizzle(database)
    .selectDistinct({ userId: session.userId })
    .from(session)
    .where(
      and(
        inArray(session.userId, userIds),
        gt(session.expiresAt, new Date(now)),
      ),
    );
  return new Set(rows.map((row) => row.userId));
}
