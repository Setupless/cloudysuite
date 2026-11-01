import { ensurePersonalDrive } from "@cloudysuite/access";
import { and, eq, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  appSettings,
  drives,
  orgSettings,
  passkey,
  user,
  type UserId,
} from "../../../../src/db/schema";
import { APPS, type AppId, type ToggleableApp } from "../../../../src/routing";

export function isToggleableApp(app: string): app is ToggleableApp {
  return Object.hasOwn(APPS, app) && APPS[app as AppId].toggleable;
}

export const TOGGLEABLE_APPS = (Object.keys(APPS) as AppId[]).filter(
  isToggleableApp,
);

export async function setRequire2fa(
  database: D1Database,
  require2fa: boolean,
): Promise<void> {
  await drizzle(database)
    .insert(orgSettings)
    .values({ id: 1, require2fa })
    .onConflictDoUpdate({ target: orgSettings.id, set: { require2fa } });
}

export async function setAppEnabled(
  database: D1Database,
  app: ToggleableApp,
  enabled: boolean,
): Promise<void> {
  await drizzle(database)
    .insert(appSettings)
    .values({ app, enabled })
    .onConflictDoUpdate({ target: appSettings.app, set: { enabled } });
}

export async function countPeopleWithoutSecondWay(
  database: D1Database,
): Promise<number> {
  const db = drizzle(database);
  const [people, keys] = await db.batch([
    db.select({ id: user.id, authenticator: user.twoFactorEnabled }).from(user),
    db.selectDistinct({ userId: passkey.userId }).from(passkey),
  ]);
  const withKey = new Set(keys.map((row) => row.userId));
  return people.filter((p) => !p.authenticator && !withKey.has(p.id)).length;
}

export type StorageOverview = {
  usedBytes: number;
  // Null means no limit.
  limitBytes: number | null;
};

export async function readStorageOverview(
  database: D1Database,
): Promise<StorageOverview> {
  const db = drizzle(database);
  const [total, settings] = await db.batch([
    db.select({ usedBytes: sum(drives.usedBytes) }).from(drives),
    db.select({ limitBytes: orgSettings.storageLimitBytes }).from(orgSettings),
  ]);
  return {
    usedBytes: Number(total[0]?.usedBytes ?? 0),
    limitBytes: settings[0]?.limitBytes ?? null,
  };
}

export async function setStorageLimit(
  database: D1Database,
  limitBytes: number | null,
): Promise<void> {
  await drizzle(database)
    .insert(orgSettings)
    .values({ id: 1, storageLimitBytes: limitBytes })
    .onConflictDoUpdate({
      target: orgSettings.id,
      set: { storageLimitBytes: limitBytes },
    });
}

// A person with no My files yet gets one now, so the limit is there when they arrive.
// Clearing a limit has nothing to keep, so it makes nothing.
export async function setMyFilesLimit(
  database: D1Database,
  userId: UserId,
  limitBytes: number | null,
): Promise<void> {
  const db = drizzle(database);
  const setLimit = db
    .update(drives)
    .set({ limitBytes })
    .where(and(eq(drives.ownerId, userId), eq(drives.kind, "personal")));
  if (limitBytes === null) {
    await setLimit;
    return;
  }
  await db.batch([...ensurePersonalDrive(db, userId), setLimit]);
}
