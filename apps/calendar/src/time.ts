import type { CivilDate, EventTime, OccurrenceId, TimeZone } from "./types";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

// A local date and time written as if it were UTC, so adding a day or an hour to it is
// plain arithmetic. It names no instant until a time zone is applied.
export type WallTime = Brand<number, "WallTime">;

export const DAY_MS = 86_400_000;
const FIRST_YEAR = 1900;
const LAST_YEAR = 2199;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OCCURRENCE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/;

export function parseCivilDate(raw: string): CivilDate | null {
  const match = DATE.exec(raw);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  if (year < FIRST_YEAR || year > LAST_YEAR) return null;
  const wall = Date.UTC(year, month - 1, day);
  return dateOfWall(wall as WallTime) === raw ? (raw as CivilDate) : null;
}

export function parseTimeZone(raw: string): TimeZone | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions()
      .timeZone as TimeZone;
  } catch {
    return null;
  }
}

export const wallOfDate = (date: CivilDate) =>
  Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  ) as WallTime;

export const dateOfWall = (wall: WallTime) =>
  new Date(wall).toISOString().slice(0, 10) as CivilDate;

export const addDays = (date: CivilDate, days: number) =>
  dateOfWall((wallOfDate(date) + days * DAY_MS) as WallTime);

export const daysBetween = (from: CivilDate, to: CivilDate) =>
  Math.round((wallOfDate(to) - wallOfDate(from)) / DAY_MS);

const formatters = new Map<TimeZone, Intl.DateTimeFormat>();

function formatterFor(zone: TimeZone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

export function wallOf(instant: number, zone: TimeZone): WallTime {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(instant)) {
    parts[part.type] = Number(part.value);
  }
  return (Date.UTC(
    parts.year as number,
    (parts.month as number) - 1,
    parts.day as number,
    parts.hour as number,
    parts.minute as number,
    parts.second as number,
  ) +
    (instant - Math.floor(instant / 1000) * 1000)) as WallTime;
}

const offsetAt = (zone: TimeZone, instant: number) =>
  wallOf(instant, zone) - instant;

// RFC 5545's reading of a local time: one that happens twice is the first, and one that
// a daylight-saving change skips uses the offset from before the change.
export function instantOf(wall: WallTime, zone: TimeZone): number {
  const before = wall - offsetAt(zone, wall - DAY_MS);
  const after = wall - offsetAt(zone, wall + DAY_MS);
  const fits = (instant: number) => wallOf(instant, zone) === wall;
  if (fits(before) && fits(after)) return Math.min(before, after);
  if (fits(after)) return after;
  return before;
}

export const startOfDay = (date: CivilDate, zone: TimeZone) =>
  instantOf(wallOfDate(date), zone);

// The day an event starts on, where the event is.
export const startDateOf = (time: EventTime) =>
  time.kind === "allDay"
    ? time.startDate
    : dateOfWall(wallOf(time.start, time.timeZone));

export const timedOccurrenceId = (instant: number) =>
  new Date(instant)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(/[-:]/g, "") as OccurrenceId;

export const allDayOccurrenceId = (date: CivilDate) =>
  date.replaceAll("-", "") as OccurrenceId;

export function parseOccurrenceId(raw: string): OccurrenceId | null {
  const match = OCCURRENCE.exec(raw);
  if (!match) return null;
  const date = parseCivilDate(`${match[1]}-${match[2]}-${match[3]}`);
  if (!date) return null;
  if (match[4] === undefined) return raw as OccurrenceId;
  const instant = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  return timedOccurrenceId(instant) === raw ? (raw as OccurrenceId) : null;
}

export const instantOfOccurrence = (id: OccurrenceId) =>
  Date.UTC(
    Number(id.slice(0, 4)),
    Number(id.slice(4, 6)) - 1,
    Number(id.slice(6, 8)),
    Number(id.slice(9, 11)),
    Number(id.slice(11, 13)),
    Number(id.slice(13, 15)),
  );

export const dateOfOccurrence = (id: OccurrenceId) =>
  `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}` as CivilDate;
