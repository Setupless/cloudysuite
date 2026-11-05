import { linkify, type TextSegment } from "@cloudysuite/ui";
import type { DayWindow } from "../schedule";
import { addDays, wallOfDate } from "../time";
import type {
  CalendarEntry,
  CivilDate,
  EventTime,
  RepeatFrequency,
  ShownRepeat,
} from "../types";

// Everything here is written in the reader's language, which only the browser knows.
// A day is formatted at UTC midnight, so formatting never moves it to another day.
const onDay = (date: CivilDate) => new Date(wallOfDate(date));
const dayFormat = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" });

// The year shows only when a date falls outside this one.
const yearUnlessThisOne = (today: CivilDate, ...dates: CivilDate[]) =>
  dates.every((date) => date.slice(0, 4) === today.slice(0, 4))
    ? undefined
    : "numeric";

const longDay = (today: CivilDate, ...dates: CivilDate[]) =>
  dayFormat({
    weekday: "long",
    day: "numeric",
    month: "long",
    year: yearUnlessThisOne(today, ...dates),
  });

// "2 to 8 November", in the reader's own order of day and month.
function rangeText(
  format: Intl.DateTimeFormat,
  start: Date,
  end: Date,
): string {
  const parts = format.formatRangeToParts(start, end);
  const lastOfStart = parts.findLastIndex(
    (part) => part.source === "startRange",
  );
  return parts
    .map((part, index) =>
      index === lastOfStart + 1 && part.source === "shared"
        ? part.value.replace(/\s*[–—-]\s*/, " to ")
        : part.value,
    )
    .join("");
}

export const dayTitle = (date: CivilDate, today: CivilDate) =>
  longDay(today, date).format(onDay(date));

export function weekTitle({ from, to }: DayWindow, today: CivilDate): string {
  const last = addDays(to, -1);
  return rangeText(
    dayFormat({
      day: "numeric",
      month: "long",
      year: yearUnlessThisOne(today, from, last),
    }),
    onDay(from),
    onDay(last),
  );
}

export const monthTitle = (date: CivilDate) =>
  dayFormat({ month: "long", year: "numeric" }).format(onDay(date));

export const weekdayShort = (date: CivilDate) =>
  dayFormat({ weekday: "short" }).format(onDay(date));

export const weekdayNarrow = (date: CivilDate) =>
  dayFormat({ weekday: "narrow" }).format(onDay(date));

export const dayNumber = (date: CivilDate) =>
  dayFormat({ day: "numeric" }).format(onDay(date));

export const dayAndMonth = (date: CivilDate) =>
  dayFormat({ day: "numeric", month: "short" }).format(onDay(date));

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export const timeText = (instant: number) => clock.format(instant);

export const hourText = (hour: number) =>
  dayFormat({ hour: "numeric", minute: "2-digit" }).format(
    wallOfDate("2026-01-01" as CivilDate) + hour * 3_600_000,
  );

export function whenText(
  time: EventTime,
  first: CivilDate,
  last: CivilDate,
  today: CivilDate,
): { days: string; hours: string } {
  if (time.kind === "allDay") {
    return {
      days:
        first === last
          ? dayTitle(first, today)
          : rangeText(longDay(today, first, last), onDay(first), onDay(last)),
      hours: "All day",
    };
  }
  if (first === last) {
    return {
      days: dayTitle(first, today),
      hours: rangeText(clock, new Date(time.start), new Date(time.end)),
    };
  }
  const withTime = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: yearUnlessThisOne(today, first, last),
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    days: rangeText(withTime, new Date(time.start), new Date(time.end)),
    hours: "",
  };
}

export const REPEAT_NAMES: Record<RepeatFrequency, string> = {
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

export function repeatText(repeat: ShownRepeat, today: CivilDate): string {
  if (repeat.frequency === "custom") return "Repeats";
  const every = REPEAT_NAMES[repeat.frequency];
  switch (repeat.end.kind) {
    case "never":
      return every;
    case "onDate":
      return `${every} until ${dayTitle(repeat.end.date, today)}`;
    case "afterTimes":
      return `${every}, ${repeat.end.times} times in all`;
  }
}

export const whoCanSee = (calendar: CalendarEntry) =>
  calendar.kind === "personal"
    ? "Only you can see this"
    : `Everyone in ${calendar.name} can see this`;

// Notes and places come from whoever wrote the event, so only https links open, in a new
// tab that isn't told this address.
export const withLinks = (text: string): TextSegment[] =>
  linkify(text).map((segment) =>
    segment.kind === "link" && !segment.href.startsWith("https://")
      ? { kind: "text", text: segment.text }
      : segment,
  );
