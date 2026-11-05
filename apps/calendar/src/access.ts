import { env } from "cloudflare:workers";
import type { CalendarId, UserId } from "@cloudysuite/access";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { assertAppOn } from "../../../src/app-on";
import { settingsFor } from "../../../src/settings";
import { openCalendarAsPerson } from "./client";
import { NO_ACCESS_MESSAGE } from "./types";
import { refusal } from "./wire";

const noAccess = () => refusal(403, NO_ACCESS_MESSAGE);

// A server function answers on every app's hostname, so each one starts here. A later
// one that reaches into Mail checks that Mail is on as well.
export async function requireCalendarUser(request: Request) {
  assertAppOn(await settingsFor(request, env.DB), "calendar");
  return requireReadyUser(request);
}

// After `requireCalendarUser`. The object then refuses a change from anyone with only
// Can view, in the call that would make it.
export async function openCalendarAs(userId: UserId, calendarId: CalendarId) {
  const calendar = await openCalendarAsPerson(env, userId, calendarId);
  if (!calendar) throw noAccess();
  return calendar;
}
