import type { CalendarId } from "@cloudysuite/access";

// Not exported from the package. Only client.ts may import this, and
// boundaries.test.ts fails if anything else touches the binding.
export function calendarStub(env: Env, calendarId: CalendarId) {
  return env.CALENDAR.get(env.CALENDAR.idFromName(calendarId));
}
