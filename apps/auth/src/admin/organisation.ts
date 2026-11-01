import { drizzle } from "drizzle-orm/d1";
import {
  appSettings,
  orgSettings,
  passkey,
  user,
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
