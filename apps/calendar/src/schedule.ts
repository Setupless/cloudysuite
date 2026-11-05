import {
  addDays,
  DAY_MS,
  dateOfWall,
  daysBetween,
  parseCivilDate,
  type WallTime,
  wallOf,
  wallOfDate,
} from "./time";
import type { CalendarOccurrence, CivilDate, TimeZone } from "./types";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export const SCHEDULE_VIEWS = ["day", "week", "month"] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];

// One date of one event on one calendar. Day view's address holds it for the panel.
export type OccurrenceKey = Brand<string, "OccurrenceKey">;

// What Schedule's address holds. No view means Week and no date means today, so the bare
// address always opens on the current week, and each place has one address.
export type ScheduleSearch = {
  view?: "day" | "month";
  date?: CivilDate;
  event?: OccurrenceKey;
};

// The view, and the day it's on. Week and Month show the week or month around that day,
// so moving between views keeps the day.
export type SchedulePlace = { view: ScheduleView; date: CivilDate };

// Whole days on the viewer's own calendar. `to` is the day after the last day shown.
export type DayWindow = { from: CivilDate; to: CivilDate };

const MAX_KEY_LENGTH = 512;

export const keyOf = (occurrence: CalendarOccurrence) =>
  `${occurrence.calendarId}/${occurrence.occurrenceId ?? "-"}/${occurrence.uid}` as OccurrenceKey;

// Anything else in the address is left out, so an edited or old link still opens a page.
export function parseScheduleSearch(
  raw: Record<string, unknown>,
): ScheduleSearch {
  const search: ScheduleSearch = {};
  if (raw.view === "day" || raw.view === "month") search.view = raw.view;
  const date = typeof raw.date === "string" ? parseCivilDate(raw.date) : null;
  if (date) search.date = date;
  if (
    search.view === "day" &&
    typeof raw.event === "string" &&
    raw.event.length <= MAX_KEY_LENGTH
  ) {
    search.event = raw.event as OccurrenceKey;
  }
  return search;
}

export function searchOf(
  view: ScheduleView,
  date: CivilDate | undefined,
  event?: OccurrenceKey,
): ScheduleSearch {
  const search: ScheduleSearch = {};
  if (view !== "week") search.view = view;
  if (date) search.date = date;
  if (view === "day" && event) search.event = event;
  return search;
}

export const placeOf = (
  search: ScheduleSearch,
  today: CivilDate,
): SchedulePlace => ({
  view: search.view ?? "week",
  date: search.date ?? today,
});

export const todayIn = (zone: TimeZone, now: number) =>
  dateOfWall(wallOf(now, zone));

// Monday is 0, as weeks start on Monday.
export const weekdayOf = (date: CivilDate) =>
  (new Date(wallOfDate(date)).getUTCDay() + 6) % 7;

export const isWeekend = (date: CivilDate) => weekdayOf(date) >= 5;

export const weekStartOf = (date: CivilDate) => addDays(date, -weekdayOf(date));

export const monthStartOf = (date: CivilDate) =>
  `${date.slice(0, 8)}01` as CivilDate;

// The same day of another month, or that month's last day when it's shorter.
export function addMonths(date: CivilDate, months: number): CivilDate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(Number(date.slice(8, 10)), lastDay);
  return dateOfWall(
    (Date.UTC(year, month, 1) + (day - 1) * DAY_MS) as WallTime,
  );
}

// Month shows whole weeks, from the Monday on or before the 1st to the Sunday on or
// after the last day.
export function visibleDays({ view, date }: SchedulePlace): DayWindow {
  switch (view) {
    case "day":
      return { from: date, to: addDays(date, 1) };
    case "week": {
      const from = weekStartOf(date);
      return { from, to: addDays(from, 7) };
    }
    case "month": {
      const first = monthStartOf(date);
      const last = addDays(addMonths(first, 1), -1);
      return {
        from: weekStartOf(first),
        to: addDays(weekStartOf(last), 7),
      };
    }
  }
}

export function steppedDate(
  { view, date }: SchedulePlace,
  by: 1 | -1,
): CivilDate {
  switch (view) {
    case "day":
      return addDays(date, by);
    case "week":
      return addDays(date, 7 * by);
    case "month":
      return addMonths(date, by);
  }
}

export const daysIn = ({ from, to }: DayWindow): CivilDate[] =>
  Array.from({ length: daysBetween(from, to) }, (_, index) =>
    addDays(from, index),
  );

export const contains = ({ from, to }: DayWindow, date: CivilDate) =>
  date >= from && date < to;
