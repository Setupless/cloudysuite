import { type DayWindow, daysIn, visibleDays, weekStartOf } from "../schedule";
import { addDays, startOfDay } from "../time";
import type { CivilDate, EventTime, TimeZone } from "../types";
import { daySpanOf } from "./schedule-layout";

type Item = { time: EventTime; title: string; cancelled: boolean };
type Timed = Extract<EventTime, { kind: "timed" }>;

export type NextEvent<Event> =
  | { kind: "today" | "tomorrow"; event: Event; start: number }
  | { kind: "none" };

// Where a timed event sits on one day: inside it, or running in from the day before or
// on into the next.
export type HoursOnDay =
  | { kind: "between"; start: number; end: number }
  | { kind: "from"; start: number }
  | { kind: "until"; end: number }
  | { kind: "allDay" };

export type WeekDay<Event> = { date: CivilDate; events: Event[] };

export type TodayPlan<Event> = {
  today: CivilDate;
  tomorrow: CivilDate;
  allDay: Event[];
  next: NextEvent<Event>;
  // Today's timed events that have ended, and the rest still to come or under way. The
  // next event has its own card, so neither list holds it.
  finished: Event[];
  ahead: Event[];
  tomorrowEvents: Event[];
  week: WeekDay<Event>[];
};

// The week around today, and tomorrow when it starts the next week. It is Schedule's
// Week window, so opening Schedule shows events already fetched.
export function todayWindow(today: CivilDate): DayWindow {
  const week = visibleDays({ view: "week", date: today });
  const tomorrow = addDays(today, 1);
  return tomorrow < week.to
    ? week
    : { from: weekStartOf(today), to: addDays(tomorrow, 1) };
}

const isTimed = <Event extends Item>(
  event: Event,
): event is Event & { time: Timed } => event.time.kind === "timed";

function onDay<Event extends Item>(
  events: readonly Event[],
  day: CivilDate,
  zone: TimeZone,
): Event[] {
  const startOf = (time: EventTime) =>
    time.kind === "allDay" ? Number.NEGATIVE_INFINITY : time.start;
  return events
    .filter((event) => {
      const { first, last } = daySpanOf(event.time, zone);
      return first <= day && day <= last;
    })
    .sort(
      (a, b) =>
        startOf(a.time) - startOf(b.time) || a.title.localeCompare(b.title),
    );
}

// A cancelled event stays on the day, marked as such, but isn't anything to go to.
function firstStartingAfter<Event extends Item>(
  events: readonly Event[],
  after: number,
): { event: Event; start: number } | undefined {
  const event = events
    .filter(isTimed)
    .find(({ time, cancelled }) => !cancelled && time.start > after);
  return event && { event, start: event.time.start };
}

export function planToday<Event extends Item>(
  events: readonly Event[],
  zone: TimeZone,
  today: CivilDate,
  now: number,
): TodayPlan<Event> {
  const tomorrow = addDays(today, 1);
  const todays = onDay(events, today, zone);
  const tomorrows = onDay(events, tomorrow, zone);
  const laterToday = firstStartingAfter(todays, now);
  // An event that started today and runs past midnight is under way, not next.
  const firstTomorrow = firstStartingAfter(
    tomorrows,
    startOfDay(tomorrow, zone) - 1,
  );
  const next: NextEvent<Event> = laterToday
    ? { kind: "today", ...laterToday }
    : firstTomorrow
      ? { kind: "tomorrow", ...firstTomorrow }
      : { kind: "none" };
  const onCard = next.kind === "none" ? null : next.event;
  const timedToday = todays.filter(isTimed).filter((event) => event !== onCard);
  return {
    today,
    tomorrow,
    allDay: todays.filter((event) => !isTimed(event)),
    next,
    finished: timedToday.filter(({ time }) => time.end <= now),
    ahead: timedToday.filter(({ time }) => time.end > now),
    tomorrowEvents: tomorrows.filter((event) => event !== onCard),
    week: daysIn(visibleDays({ view: "week", date: today })).map((date) => ({
      date,
      events: onDay(events, date, zone),
    })),
  };
}

export function hoursOnDay(
  time: EventTime,
  day: CivilDate,
  zone: TimeZone,
): HoursOnDay {
  if (time.kind === "allDay") return { kind: "allDay" };
  const { first, last } = daySpanOf(time, zone);
  if (first === day && last === day) {
    return { kind: "between", start: time.start, end: time.end };
  }
  if (first === day) return { kind: "from", start: time.start };
  if (last === day) return { kind: "until", end: time.end };
  return { kind: "allDay" };
}

const MINUTE_MS = 60_000;

const counted = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

// Rounded up, so an event never reads as starting sooner than it does.
export function untilText(start: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((start - now) / MINUTE_MS));
  if (minutes < 60) return `in ${counted(minutes, "minute")}`;
  const hours = counted(Math.floor(minutes / 60), "hour");
  const rest = minutes % 60;
  return rest === 0 ? `in ${hours}` : `in ${hours} ${counted(rest, "minute")}`;
}
