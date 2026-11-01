import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appSettings, domains } from "./db/schema";
import type { Settings } from "./routing";

export async function readSettings(database: D1Database): Promise<Settings> {
  const db = drizzle(database);
  const [primary, disabled] = await db.batch([
    db
      .select({ name: domains.name })
      .from(domains)
      .where(eq(domains.isPrimary, true)),
    db
      .select({ app: appSettings.app })
      .from(appSettings)
      .where(eq(appSettings.enabled, false)),
  ]);
  return {
    primaryDomain: primary[0]?.name ?? null,
    disabled: new Set(disabled.map((row) => row.app)),
  };
}
