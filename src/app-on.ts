import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appSettings } from "./db/schema";
import type { ToggleableApp } from "./routing";

const OFF_MESSAGE: Record<ToggleableApp, string> = {
  mail: "An admin turned Mail off. Your mail is safe, and it comes back when it's turned on again.",
  storage:
    "An admin turned Storage off. Your files are safe, and they come back when it's turned on again.",
};

export async function isAppOff(
  database: D1Database,
  app: ToggleableApp,
): Promise<boolean> {
  const [off] = await drizzle(database)
    .select({ app: appSettings.app })
    .from(appSettings)
    .where(and(eq(appSettings.app, app), eq(appSettings.enabled, false)));
  return off !== undefined;
}

export const appOffRefusal = (app: ToggleableApp) =>
  new Response(JSON.stringify({ message: OFF_MESSAGE[app] }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });

// The hostname router can't do this alone. A server function answers on every app's
// hostname, so with an app off one could still be called through another's.
export async function assertAppOn(
  database: D1Database,
  app: ToggleableApp,
): Promise<void> {
  if (await isAppOff(database, app)) throw appOffRefusal(app);
}
