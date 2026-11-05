import { dehydrate, QueryClient, queryOptions } from "@tanstack/react-query";
import type { CalendarId } from "@cloudysuite/access";
import {
  countCalendarEvents,
  getCalendars,
  getMembers,
  getPeopleChoices,
  listEvents,
} from "./functions";
import {
  type DayWindow,
  placeOf,
  type ScheduleSearch,
  todayIn,
  visibleDays,
} from "./schedule";
import { addDays } from "./time";
import type { TimeZone } from "./types";
import { todayWindow } from "./ui/today-plan";

const CANNOT_REACH =
  "We couldn't reach CloudySuite. Check your connection and try again.";
const SOMETHING_WENT_WRONG =
  "Something went wrong on our side. Try again in a moment.";

export class CalendarFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// A refusal from a server function arrives as a thrown Response. What the person sees is
// the plain message the server wrote, or a plain message from here.
async function asFailure(thrown: unknown): Promise<CalendarFailure> {
  if (thrown instanceof CalendarFailure) return thrown;
  if (!(thrown instanceof Response)) {
    return new CalendarFailure(0, CANNOT_REACH);
  }
  const body = (await thrown
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown } | null;
  return new CalendarFailure(
    thrown.status,
    typeof body?.message === "string" ? body.message : SOMETHING_WENT_WRONG,
  );
}

export async function call<Result>(run: () => Promise<Result>) {
  try {
    return await run();
  } catch (thrown) {
    throw await asFailure(thrown);
  }
}

export const retryUnlessRefused = (failures: number, error: Error): boolean =>
  !(
    error instanceof CalendarFailure &&
    error.status >= 400 &&
    error.status < 500
  ) && failures < 2;

export const calendarKeys = {
  all: ["calendar"] as const,
  calendars: ["calendar", "calendars"] as const,
  members: (calendarId: CalendarId) =>
    ["calendar", "members", calendarId] as const,
  eventCount: (calendarId: CalendarId) =>
    ["calendar", "eventCount", calendarId] as const,
  people: ["calendar", "people"] as const,
  events: ({ from, to }: DayWindow) =>
    ["calendar", "events", from, to] as const,
};

export const calendarsQuery = () =>
  queryOptions({
    queryKey: calendarKeys.calendars,
    queryFn: () => call(() => getCalendars()),
  });

export const membersQuery = (calendarId: CalendarId) =>
  queryOptions({
    queryKey: calendarKeys.members(calendarId),
    queryFn: () => call(() => getMembers({ data: { calendarId } })),
  });

// Asked again each time, so the delete confirmation never shows an old count.
export const eventCountQuery = (calendarId: CalendarId) =>
  queryOptions({
    queryKey: calendarKeys.eventCount(calendarId),
    queryFn: () => call(() => countCalendarEvents({ data: { calendarId } })),
    staleTime: 0,
    gcTime: 0,
  });

export const peopleChoicesQuery = () =>
  queryOptions({
    queryKey: calendarKeys.people,
    queryFn: () => call(() => getPeopleChoices()),
  });
const UTC = "UTC" as TimeZone;

// The server doesn't know the reader's time zone, so the ask is in whole UTC days with a
// day to spare on each side, which holds every event on the reader's own days. The page
// places them on its own clock.
export const eventsQuery = (window: DayWindow) =>
  queryOptions({
    queryKey: calendarKeys.events(window),
    queryFn: () =>
      call(() =>
        listEvents({
          data: {
            from: addDays(window.from, -1),
            to: addDays(window.to, 1),
            timeZone: UTC,
          },
        }),
      ),
  });

// The first HTML holds the events, so the page draws them as soon as it can. Without a
// date in the address, the server's own day stands in for the reader's, which is the
// same day for most of the day in most places. When it isn't, the page asks again.
export async function prefetchSchedule(search: ScheduleSearch) {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  const place = placeOf(search, todayIn(UTC, Date.now()));
  await client.prefetchQuery(eventsQuery(visibleDays(place)));
  return dehydrate(client);
}

// The server's own day stands in for the reader's here too, for the same reason.
export async function prefetchToday() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(
    eventsQuery(todayWindow(todayIn(UTC, Date.now()))),
  );
  return dehydrate(client);
}

// The first HTML holds the sidebar's calendars, so a reload shows them at once.
export async function prefetchCalendars() {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await client.prefetchQuery(calendarsQuery());
  return dehydrate(client);
}
