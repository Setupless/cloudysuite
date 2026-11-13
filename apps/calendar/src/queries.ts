import {
  keepPreviousData,
  MutationCache,
  QueryCache,
  QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import type { CalendarId } from "@cloudysuite/access";
import { pageData, pageQueryClient } from "@cloudysuite/page-data";
import type { PlainDate } from "@cloudysuite/tasks/in-calendar";
import {
  countCalendarEvents,
  getCalendars,
  getMembers,
  getOutsideInviting,
  getPeopleChoices,
  listEvents,
  listInvitations,
  listUnsentCancellations,
} from "./functions";
import {
  type DayWindow,
  placeOf,
  type ScheduleSearch,
  todayIn,
  visibleDays,
} from "./schedule";
import { searchEvents } from "./search-functions";
import { listDueTasks } from "./task-functions";
import { addDays, deviceZone } from "./time";
import type { CivilDate, EventUid, TimeZone } from "./types";
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

// An expired session surfaces here first. The reload reaches the route's sign-in check,
// which sends the person to sign in and back again.
function reloadIfSignedOut(error: Error) {
  if (error instanceof CalendarFailure && error.status === 401) {
    window.location.reload();
  }
}

function createCalendarQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reloadIfSignedOut }),
    mutationCache: new MutationCache({ onError: reloadIfSignedOut }),
    defaultOptions: {
      mutations: { networkMode: "always" },
      queries: {
        networkMode: "always",
        // Only long enough that the first HTML's data isn't fetched again as the page
        // wakes up.
        staleTime: 2_000,
        retry: retryUnlessRefused,
        refetchOnWindowFocus: true,
      },
    },
  });
}

export const calendarQueryClient = pageQueryClient(createCalendarQueryClient);
const firstData = pageData(calendarQueryClient);

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
  searches: ["calendar", "search"] as const,
  search: (text: string, zone: TimeZone) =>
    ["calendar", "search", text, zone] as const,
  invitations: (zone: TimeZone) => ["calendar", "invitations", zone] as const,
  tasks: ["calendar", "tasks"] as const,
  dueTasks: (from: CivilDate | null, to: CivilDate) =>
    ["calendar", "tasks", from, to] as const,
  unsentCancellations: (calendarId: CalendarId) =>
    ["calendar", "unsentCancellations", calendarId] as const,
};

export const unsentCancellationsQuery = (calendarId: CalendarId) =>
  queryOptions({
    queryKey: calendarKeys.unsentCancellations(calendarId),
    queryFn: () =>
      call(() => listUnsentCancellations({ data: { calendarId } })),
  });

export const invitationsQuery = (timeZone: TimeZone) =>
  queryOptions({
    queryKey: calendarKeys.invitations(timeZone),
    queryFn: () => call(() => listInvitations({ data: { timeZone } })),
  });

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

// Asked each time the dialog opens, since Mail can be turned off at any time.
// No event asks about the person's own address, for a new one.
export const outsideInvitingQuery = (
  event: { calendarId: CalendarId; uid: EventUid } | null,
) =>
  queryOptions({
    queryKey: [
      "calendar",
      "outsideInviting",
      event?.calendarId ?? null,
      event?.uid ?? null,
    ] as const,
    queryFn: () => call(() => getOutsideInviting({ data: { event } })),
    staleTime: 0,
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

// The person's own open tasks due from `from`, or ever before when it's null, up to the
// day before `to`. Not prefetched, so a slow board can't hold up the page.
export const dueTasksQuery = (from: CivilDate | null, to: CivilDate) =>
  queryOptions({
    queryKey: calendarKeys.dueTasks(from, to),
    queryFn: () =>
      call(() =>
        listDueTasks({
          data: {
            from: from as string | null as PlainDate | null,
            to: to as string as PlainDate,
          },
        }),
      ),
  });

// The zone decides which all-day events are past, and which date a repeat shows.
export const searchQuery = (text: string, zone: TimeZone) =>
  queryOptions({
    queryKey: calendarKeys.search(text, zone),
    queryFn: () => call(() => searchEvents({ data: { text, timeZone: zone } })),
    placeholderData: keepPreviousData,
  });

// The first HTML holds the events, so the page draws them as soon as it can. Without a
// date in the address, the server's own day stands in for the reader's, which is the
// same day for most of the day in most places. When it isn't, the page asks again.
export function prefetchSchedule(search: ScheduleSearch) {
  const today = todayIn(import.meta.env.SSR ? UTC : deviceZone(), Date.now());
  const days = visibleDays(placeOf(search, today));
  return firstData((load) => [load.query(eventsQuery(days))]);
}

// The server's own day stands in for the reader's here too, for the same reason.
export function prefetchOverview() {
  const today = todayIn(import.meta.env.SSR ? UTC : deviceZone(), Date.now());
  return firstData((load) => [load.query(eventsQuery(todayWindow(today)))]);
}

// The first HTML holds the sidebar's calendars, so a reload shows them at once.
export const prefetchCalendars = () =>
  firstData((load) => [load.query(calendarsQuery())]);
