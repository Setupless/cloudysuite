import ICAL from "ical.js";
import { followableRule } from "./followable";
import {
  addDays,
  allDayOccurrenceId,
  type WallTime,
  DAY_MS,
  daysBetween,
  dateOfWall,
  instantOf,
  startOfDay,
  timedOccurrenceId,
  wallOf,
  wallOfDate,
} from "./time";
import type {
  CivilDate,
  EventTime,
  OccurrenceId,
  Repeat,
  RepeatFrequency,
  ShownRepeat,
} from "./types";

const RULES: Record<RepeatFrequency, string> = {
  daily: "FREQ=DAILY",
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekly: "FREQ=WEEKLY",
  fortnightly: "FREQ=WEEKLY;INTERVAL=2",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY",
};

const WEEKDAYS = new Set(["MO", "TU", "WE", "TH", "FR"]);

// Local dates sit between UTC-12 and UTC+14, so these bound any day in any zone.
const EARLIEST_ZONE_MS = 14 * 60 * 60 * 1000;
const LATEST_ZONE_MS = 12 * 60 * 60 * 1000;

// Shared by every series in one request, so one unbounded or huge rule from outside
// can't stall the page. Running out leaves the listing marked incomplete.
export type Budget = { steps: number };

export type DateOfSeries = { id: OccurrenceId; time: EventTime };

// The one way a stored rule reaches ical.js.
function parseRule(rule: string): ICAL.Recur | null {
  if (!followableRule(rule)) return null;
  try {
    const recur = ICAL.Recur.fromString(rule);
    return recur.freq ? recur : null;
  } catch {
    return null;
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

const dateOfIcal = (time: ICAL.Time) =>
  `${time.year}-${pad(time.month)}-${pad(time.day)}` as CivilDate;

const wallOfIcal = (time: ICAL.Time) =>
  Date.UTC(
    time.year,
    time.month - 1,
    time.day,
    time.hour,
    time.minute,
    time.second,
  ) as WallTime;

const isUtc = (time: ICAL.Time) => time.zone?.tzid === "UTC";

// iCalendar wants UNTIL in UTC when the start has a time zone, so a timed repeat ends at
// the last moment of that day where the event is.
function untilFor(date: CivilDate, time: EventTime): string {
  return time.kind === "allDay"
    ? allDayOccurrenceId(date)
    : timedOccurrenceId(startOfDay(addDays(date, 1), time.timeZone) - 1000);
}

export function ruleOf(repeat: Repeat, time: EventTime): string {
  const rule = RULES[repeat.frequency];
  switch (repeat.end.kind) {
    case "never":
      return rule;
    case "afterTimes":
      return `${rule};COUNT=${repeat.end.times}`;
    case "onDate":
      return `${rule};UNTIL=${untilFor(repeat.end.date, time)}`;
  }
}

function untilDate(until: ICAL.Time, time: EventTime): CivilDate {
  if (until.isDate || !isUtc(until) || time.kind === "allDay") {
    return dateOfIcal(until);
  }
  return dateOfWall(wallOf(wallOfIcal(until), time.timeZone));
}

function frequencyOf(recur: ICAL.Recur): RepeatFrequency | null {
  const parts = Object.entries(recur.parts).filter(
    ([, values]) => values && values.length > 0,
  );
  if (recur.interval === 2) {
    return recur.freq === "WEEKLY" && parts.length === 0 ? "fortnightly" : null;
  }
  if (recur.interval !== 1) return null;
  if (parts.length === 0) {
    const plain: Record<string, RepeatFrequency> = {
      DAILY: "daily",
      WEEKLY: "weekly",
      MONTHLY: "monthly",
      YEARLY: "yearly",
    };
    return plain[recur.freq] ?? null;
  }
  const [only] = parts;
  const days = new Set(only?.[1] as string[]);
  const weekdays =
    recur.freq === "WEEKLY" &&
    parts.length === 1 &&
    only?.[0] === "BYDAY" &&
    days.size === WEEKDAYS.size &&
    [...days].every((day) => WEEKDAYS.has(day));
  return weekdays ? "weekdays" : null;
}

export function repeatOf(rule: string, time: EventTime): ShownRepeat {
  const recur = parseRule(rule);
  const frequency = recur && frequencyOf(recur);
  if (!recur || !frequency || (recur.count && recur.until)) {
    return { frequency: "custom" };
  }
  if (recur.count) {
    return { frequency, end: { kind: "afterTimes", times: recur.count } };
  }
  if (recur.until) {
    return {
      frequency,
      end: { kind: "onDate", date: untilDate(recur.until, time) },
    };
  }
  return { frequency, end: { kind: "never" } };
}

// A plain yearly repeat from 29 February would land on 1 March in other years, where
// RFC 5545 skips them, so the day it implies is spelled out for ical.js.
function iteratorFrom(recur: ICAL.Recur, first: ICAL.Time) {
  const plain = Object.values(recur.parts).every((values) => !values?.length);
  if (
    recur.freq === "YEARLY" &&
    plain &&
    first.month === 2 &&
    first.day === 29
  ) {
    recur.setComponent("BYMONTH", [2]);
    recur.setComponent("BYMONTHDAY", [29]);
  }
  return recur.iterator(first);
}

// Yields each date's original start in order, until the rule ends or the budget runs out.
// UNTIL is checked here rather than by ical.js, which would compare a UTC end with a
// local start as though both were UTC.
export function* datesOf(
  rule: string,
  time: EventTime,
  budget: Budget,
): Generator<DateOfSeries> {
  const recur = parseRule(rule);
  // The start is always the first date, whatever the rule says after it.
  if (!recur) {
    if (budget.steps-- <= 0) return;
    yield {
      id:
        time.kind === "allDay"
          ? allDayOccurrenceId(time.startDate)
          : timedOccurrenceId(time.start),
      time,
    };
    return;
  }
  const until = recur.until;
  recur.until = null;

  if (time.kind === "allDay") {
    const days = daysBetween(time.startDate, time.endDate);
    const last = until && untilDate(until, time);
    const dates = iteratorFrom(recur, ICAL.Time.fromDateString(time.startDate));
    while (budget.steps-- > 0) {
      const next = dates.next();
      if (!next) return;
      const date = dateOfIcal(next);
      if (last && date > last) return;
      yield {
        id: allDayOccurrenceId(date),
        time: { kind: "allDay", startDate: date, endDate: addDays(date, days) },
      };
    }
    return;
  }

  const { timeZone } = time;
  const length = time.end - time.start;
  const start = new Date(wallOf(time.start, timeZone));
  const dates = iteratorFrom(
    recur,
    ICAL.Time.fromData({
      year: start.getUTCFullYear(),
      month: start.getUTCMonth() + 1,
      day: start.getUTCDate(),
      hour: start.getUTCHours(),
      minute: start.getUTCMinutes(),
      second: start.getUTCSeconds(),
      isDate: false,
    }),
  );
  const pastUntil = (wall: WallTime, instant: number) => {
    if (!until) return false;
    if (until.isDate) return dateOfWall(wall) > dateOfIcal(until);
    if (isUtc(until)) return instant > wallOfIcal(until);
    return wall > wallOfIcal(until);
  };
  while (budget.steps-- > 0) {
    const next = dates.next();
    if (!next) return;
    const wall = wallOfIcal(next);
    const instant = instantOf(wall, timeZone);
    if (pastUntil(wall, instant)) return;
    yield {
      id: timedOccurrenceId(instant),
      time: { kind: "timed", start: instant, end: instant + length, timeZone },
    };
  }
}

export function firstDateOf(rule: string, time: EventTime): EventTime | null {
  for (const date of datesOf(rule, time, { steps: 1 })) return date.time;
  return null;
}

// How many dates of the series come before this one, or null if the series has no such
// date. Ids sort in time order, so the walk stops once it passes.
export function indexOf(
  rule: string,
  time: EventTime,
  id: OccurrenceId,
  budget: Budget,
): number | null {
  let index = 0;
  for (const date of datesOf(rule, time, budget)) {
    if (date.id === id) return index;
    if (date.id > id) return null;
    index++;
  }
  return null;
}

// Where an event's dates could fall, in UTC, wide enough for every time zone. Only the
// range query reads these, so they may be loose but never too narrow.
export function spanOf(
  time: EventTime,
  rule: string | null,
): { start: number; end: number | null } {
  const [start, end] =
    time.kind === "allDay"
      ? [
          wallOfDate(time.startDate) - EARLIEST_ZONE_MS,
          wallOfDate(time.endDate) + LATEST_ZONE_MS,
        ]
      : [time.start, time.end];
  if (rule === null) return { start, end };
  const until = parseRule(rule)?.until;
  if (!until) return { start, end: null };
  const last = until.isDate
    ? wallOfDate(dateOfIcal(until)) + DAY_MS + EARLIEST_ZONE_MS
    : wallOfIcal(until) + (isUtc(until) ? 0 : EARLIEST_ZONE_MS);
  return { start, end: last + (end - start) };
}
