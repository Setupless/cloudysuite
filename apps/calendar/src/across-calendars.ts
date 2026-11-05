import type { CalendarId, UserId } from "@cloudysuite/access";
import { askEach, type SearchTerm } from "@cloudysuite/search";
import type { CalendarClient } from "./client";
import { readMyCalendars } from "./directory";
import { inSearchOrder } from "./event-search";
import type { EventSearchAnswer, TimeZone } from "./types";

const RESULTS_SHOWN = 100;

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
  const sorted = answers
    .flatMap((answer) => answer.occurrences)
    .sort(inSearchOrder(zone, Date.now()));
  return {
    status: "found",
    occurrences: sorted.slice(0, RESULTS_SHOWN),
    more:
      answers.some((answer) => answer.more) || sorted.length > RESULTS_SHOWN,
    incomplete: incomplete || answers.some((answer) => !answer.complete),
  };
}
