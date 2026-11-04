import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appSettings, domains, orgSettings } from "./db/schema";
import type { Settings } from "./routing";

type StoredSettings = Settings & { require2fa: boolean };

export async function readSettings(
  database: D1Database,
): Promise<StoredSettings> {
  const db = drizzle(database);
  const [primary, disabled, org] = await db.batch([
    db
      .select({ name: domains.name })
      .from(domains)
      .where(eq(domains.isPrimary, true)),
    db
      .select({ app: appSettings.app })
      .from(appSettings)
      .where(eq(appSettings.enabled, false)),
    db.select({ require2fa: orgSettings.require2fa }).from(orgSettings),
  ]);
  return {
    primaryDomain: primary[0]?.name ?? null,
    disabled: new Set(disabled.map((row) => row.app)),
    require2fa: org[0]?.require2fa ?? false,
  };
}

// The hostname router and every check after it in one request share one read. The
// next request reads again, so an admin's change applies from then on.
const perRequest = new WeakMap<Request, Promise<StoredSettings>>();

export function settingsFor(
  request: Request,
  database: D1Database,
): Promise<StoredSettings> {
  let settings = perRequest.get(request);
  if (!settings) {
    settings = readSettings(database);
    perRequest.set(request, settings);
  }
  return settings;
}
