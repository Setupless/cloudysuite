import { keyOf, type OccurrenceKey } from "../schedule";
import type {
  CalendarEntry,
  CalendarOccurrence,
  CivilDate,
  EventListing,
  TimeZone,
} from "../types";
import { whenText } from "./event-text";
import { daySpanOf } from "./schedule-layout";

export type ShownEvent = CalendarOccurrence & {
  key: OccurrenceKey;
  calendar: CalendarEntry;
};

// A calendar hidden in the sidebar leaves at once, before the server has heard.
export function shownEvents(
  listing: EventListing | undefined,
  calendars: CalendarEntry[] | undefined,
): ShownEvent[] {
  const shown = new Map(
    (calendars ?? []).flatMap((entry) =>
      entry.id && !entry.hidden ? [[entry.id, entry] as const] : [],
    ),
  );
  return (listing?.occurrences ?? []).flatMap((occurrence) => {
    const calendar = shown.get(occurrence.calendarId);
    return calendar
      ? [{ ...occurrence, key: keyOf(occurrence), calendar }]
      : [];
  });
}

export function whenOf(event: ShownEvent, zone: TimeZone, today: CivilDate) {
  const { first, last } = daySpanOf(event.time, zone);
  return whenText(event.time, first, last, today);
}

export function spokenLabel(
  event: ShownEvent,
  zone: TimeZone,
  today: CivilDate,
): string {
  const { days, hours } = whenOf(event, zone, today);
  const state = event.cancelled
    ? "cancelled"
    : event.answer === "needsAnswer"
      ? "invitation, not answered yet"
      : event.answer === "no"
        ? "not going"
        : null;
  return [event.title, days, hours, event.calendar.name, state]
    .filter(Boolean)
    .join(", ");
}
