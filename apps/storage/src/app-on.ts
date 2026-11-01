import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appSettings } from "../../../src/db/schema";

export const STORAGE_OFF_MESSAGE =
  "An admin turned Storage off. Your files are safe, and they come back when it's turned on again.";

export const MAIL_OFF_MESSAGE =
  "An admin turned Mail off, so attachments can't be saved from it. Nothing was changed, and you can save them when it's turned on again.";

async function isOff(database: D1Database, app: "storage" | "mail") {
  const [off] = await drizzle(database)
    .select({ app: appSettings.app })
    .from(appSettings)
    .where(and(eq(appSettings.app, app), eq(appSettings.enabled, false)));
  return off !== undefined;
}

const refusal = (message: string) =>
  new Response(JSON.stringify({ message }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });

// The hostname router can't do this alone. A server function answers on every app's
// hostname, so with Storage off one could still be called through Mail's.
export async function assertStorageOn(database: D1Database): Promise<void> {
  if (await isOff(database, "storage")) throw refusal(STORAGE_OFF_MESSAGE);
}

export const isMailOff = (database: D1Database) => isOff(database, "mail");

export async function assertMailOn(database: D1Database): Promise<void> {
  if (await isMailOff(database)) throw refusal(MAIL_OFF_MESSAGE);
}
