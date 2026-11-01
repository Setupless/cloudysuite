import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appSettings } from "../../../src/db/schema";

export const STORAGE_OFF_MESSAGE =
  "An admin turned Storage off. Your files are safe, and they come back when it's turned on again.";

// The hostname router can't do this alone. A server function answers on every app's
// hostname, so with Storage off one could still be called through Mail's.
export async function assertStorageOn(database: D1Database): Promise<void> {
  const [off] = await drizzle(database)
    .select({ app: appSettings.app })
    .from(appSettings)
    .where(and(eq(appSettings.app, "storage"), eq(appSettings.enabled, false)));
  if (!off) return;
  throw new Response(JSON.stringify({ message: STORAGE_OFF_MESSAGE }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}
