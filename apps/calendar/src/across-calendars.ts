import type { CalendarId, UserId } from "@cloudysuite/access";
import { askEach, type SearchTerm } from "@cloudysuite/search";
import type { CalendarClient } from "./client";
import { readMyCalendars } from "./directory";
import { inSearchOrder } from "./event-search";
import type {
  CalendarOccurrence,
  EventSearchAnswer,
  EventUid,
  TimeZone,
} from "./types";

const RESULTS_SHOWN = 100;

// Someone invited to an event on a team calendar they also see would find it twice. They
// see their own copy, with their answer. Schedule matches each date, and search, which
// finds an event once, matches the event. A copy names the calendar and UID it follows.
// Only a copy sent to the viewer counts, which is one that holds their answer. A copy in
// a calendar handed to them was someone else's, and no longer hears from the organiser.
export function withOwnCopies(
  entries: readonly CalendarOccurrence[],
  match: "perDate" | "perEvent",
): CalendarOccurrence[] {
  const keyOf = (
    calendarId: CalendarId,
    uid: EventUid,
    entry: CalendarOccurrence,
  ) =>
    match === "perDate"
      ? `${calendarId} ${uid} ${entry.occurrenceId ?? ""}`
      : `${calendarId} ${uid}`;
  const copies = new Set(
    entries.flatMap((entry) =>
      entry.organiser.kind === "colleague" && entry.answer !== null
        ? [keyOf(entry.organiser.calendarId, entry.organiser.uid, entry)]
        : [],
    ),
  );
  return entries.filter(
    (entry) => !copies.has(keyOf(entry.calendarId, entry.uid, entry)),
  );
}

export type OpenCalendar = (calendarId: CalendarId) => Promise<CalendarClient>;

// Only the calendars the person sees and hasn't hidden, which is what Schedule shows.
export async function searchCalendars(
  database: D1Database,
  person: { id: UserId; name: string },
  open: OpenCalendar,
  terms: SearchTerm[],
  zone: TimeZone,
): Promise<Extract<EventSearchAnswer, { status: "found" }>> {
  const shown = (await readMyCalendars(database, person)).flatMap((entry) =>
    entry.id && !entry.hidden ? [entry.id] : [],
  );
  const { answers, incomplete } = await askEach(shown, async (calendarId) => {
    const result = await (await open(calendarId)).search(terms, zone);
    return {
      more: result.more,
      complete: result.complete,
      occurrences: result.occurrences.map((occurrence) => ({
        ...occurrence,
        calendarId,
      })),
    };
  });
  const sorted = withOwnCopies(
    answers.flatMap((answer) => answer.occurrences),
    "perEvent",
  ).sort(inSearchOrder(zone, Date.now()));
  return {
    status: "found",
    occurrences: sorted.slice(0, RESULTS_SHOWN),
    more:
      answers.some((answer) => answer.more) || sorted.length > RESULTS_SHOWN,
    incomplete: incomplete || answers.some((answer) => !answer.complete),
  };
}
