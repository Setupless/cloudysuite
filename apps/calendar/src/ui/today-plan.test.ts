import { expect, test } from "bun:test";
import type { CalendarId, UserId } from "@cloudysuite/access";
import { todayIn } from "../schedule";
import { instantOf, parseTimeZone, type WallTime, wallOfDate } from "../time";
import type {
  CalendarEntry,
  CalendarOccurrence,
  CivilDate,
  EventTime,
  EventUid,
  TimeZone,
} from "../types";
import { shownEvents } from "./shown-event";
import { hoursOnDay, planToday, todayWindow, untilText } from "./today-plan";

const zone = (name: string) => parseTimeZone(name) as TimeZone;
const SYDNEY = zone("Australia/Sydney");
const AUCKLAND = zone("Pacific/Auckland");
const LOS_ANGELES = zone("America/Los_Angeles");
const date = (raw: string) => raw as CivilDate;
const MINUTE = 60_000;

type Shown = { title: string; time: EventTime; cancelled: boolean };

function at(day: string, clock: string, where: TimeZone = SYDNEY): number {
  const [hours, minutes] = clock.split(":").map(Number) as [number, number];
  return instantOf(
    (wallOfDate(date(day)) + (hours * 60 + minutes) * MINUTE) as WallTime,
    where,
  );
}

function timed(
  title: string,
  day: string,
  start: string,
  minutes: number,
): Shown {
  const instant = at(day, start);
  return {
    title,
    time: {
      kind: "timed",
      start: instant,
      end: instant + minutes * MINUTE,
      timeZone: SYDNEY,
    },
    cancelled: false,
  };
}

const allDay = (title: string, first: string, after: string): Shown => ({
  title,
  time: { kind: "allDay", startDate: date(first), endDate: date(after) },
  cancelled: false,
});

const planAt = (events: Shown[], now: number, where: TimeZone = SYDNEY) =>
  planToday(events, where, todayIn(where, now), now);

const titles = (events: Shown[]) => events.map((event) => event.title);

// Thursday 5 November 2026 in Sydney, as in the design concept.
const THURSDAY = [
  allDay("Trade show", "2026-11-05", "2026-11-06"),
  timed("Team standup", "2026-11-05", "09:30", 30),
  timed("Spring launch review", "2026-11-05", "11:00", 60),
  timed("1:1 with Tom", "2026-11-05", "14:00", 45),
  timed("Invoice run", "2026-11-05", "16:00", 60),
  timed("Standup Friday", "2026-11-06", "09:30", 30),
  timed("Press briefing", "2026-11-06", "10:30", 30),
  allDay("Offsite", "2026-11-06", "2026-11-07"),
];

test("the next event is the soonest still to come, and finished ones fold away", () => {
  const now = at("2026-11-05", "10:35");
  const plan = planAt(THURSDAY, now);
  expect(plan.next.kind).toBe("today");
  expect(plan.next.kind !== "none" && plan.next.event.title).toBe(
    "Spring launch review",
  );
  expect(titles(plan.finished)).toEqual(["Team standup"]);
  expect(titles(plan.ahead)).toEqual(["1:1 with Tom", "Invoice run"]);
  expect(titles(plan.allDay)).toEqual(["Trade show"]);
  expect(plan.next.kind !== "none" && untilText(plan.next.start, now)).toBe(
    "in 25 minutes",
  );
});

test("an event under way stays in the rest of today, and the card moves to the one after", () => {
  const plan = planAt(THURSDAY, at("2026-11-05", "11:20"));
  expect(plan.next.kind !== "none" && plan.next.event.title).toBe(
    "1:1 with Tom",
  );
  expect(titles(plan.ahead)).toEqual(["Spring launch review", "Invoice run"]);
  expect(titles(plan.finished)).toEqual(["Team standup"]);
});

test("in the evening the card takes tomorrow's first event, and Tomorrow leaves it out", () => {
  const plan = planAt(THURSDAY, at("2026-11-05", "18:33"));
  expect(plan.next.kind).toBe("tomorrow");
  expect(plan.next.kind !== "none" && plan.next.event.title).toBe(
    "Standup Friday",
  );
  expect(titles(plan.finished)).toEqual([
    "Team standup",
    "Spring launch review",
    "1:1 with Tom",
    "Invoice run",
  ]);
  expect(plan.ahead).toEqual([]);
  expect(titles(plan.tomorrowEvents)).toEqual(["Offsite", "Press briefing"]);
});

test("a cancelled event is never next, and stays in the rest of today", () => {
  const calledOff = THURSDAY.map((event) =>
    event.title === "Spring launch review"
      ? { ...event, cancelled: true }
      : event,
  );
  const plan = planAt(calledOff, at("2026-11-05", "10:35"));
  expect(plan.next.kind !== "none" && plan.next.event.title).toBe(
    "1:1 with Tom",
  );
  expect(titles(plan.ahead)).toEqual(["Spring launch review", "Invoice run"]);
});

test("with nothing left today or tomorrow, there is no next event", () => {
  const plan = planAt(THURSDAY.slice(0, 5), at("2026-11-05", "18:33"));
  expect(plan.next).toEqual({ kind: "none" });
  expect(plan.tomorrowEvents).toEqual([]);
});

test("near midnight, an event under way is not next, and the next one is tomorrow's", () => {
  const lateShift = timed("Late shift", "2026-11-05", "23:30", 60);
  const early = timed("Early call", "2026-11-06", "00:10", 20);
  const before = planAt([early, lateShift], at("2026-11-05", "23:50"));
  expect(before.next.kind).toBe("tomorrow");
  expect(before.next.kind !== "none" && before.next.event.title).toBe(
    "Early call",
  );
  expect(titles(before.ahead)).toEqual(["Late shift"]);
  expect(titles(before.tomorrowEvents)).toEqual(["Late shift"]);
  expect(hoursOnDay(lateShift.time, before.today, SYDNEY).kind).toBe("from");
  expect(hoursOnDay(lateShift.time, before.tomorrow, SYDNEY).kind).toBe(
    "until",
  );

  const after = planAt([early, lateShift], at("2026-11-06", "00:05"));
  expect(after.today).toBe(date("2026-11-06"));
  expect(after.next.kind).toBe("today");
  expect(after.next.kind !== "none" && after.next.event.title).toBe(
    "Early call",
  );
  expect(
    after.next.kind !== "none" &&
      untilText(after.next.start, at("2026-11-06", "00:05")),
  ).toBe("in 5 minutes");
  expect(titles(after.ahead)).toEqual(["Late shift"]);
});

test("an all-day event is on Overview wherever its date is today", () => {
  const holiday = allDay("Holiday", "2026-11-05", "2026-11-06");
  const nextDay = allDay("Next day", "2026-11-06", "2026-11-07");
  // 12:00 on the 5th in Los Angeles is 09:00 on the 6th in Auckland.
  const moment = at("2026-11-05", "12:00", LOS_ANGELES);

  const losAngeles = planAt([holiday, nextDay], moment, LOS_ANGELES);
  expect(titles(losAngeles.allDay)).toEqual(["Holiday"]);
  expect(titles(losAngeles.tomorrowEvents)).toEqual(["Next day"]);

  const auckland = planAt([holiday, nextDay], moment, AUCKLAND);
  expect(titles(auckland.allDay)).toEqual(["Next day"]);
  expect(auckland.tomorrowEvents).toEqual([]);
});

test("a hidden calendar's events are left out of Overview", () => {
  const entry = (id: string, hidden: boolean): CalendarEntry => ({
    id: id as CalendarId,
    kind: "team",
    name: id,
    colour: 1,
    role: "editor",
    hidden,
  });
  const occurrence = (
    calendarId: string,
    shown: Shown,
  ): CalendarOccurrence => ({
    ...shown,
    calendarId: calendarId as CalendarId,
    uid: `${shown.title}@test` as EventUid,
    occurrenceId: null,
    repeat: null,
    location: "",
    notes: "",
    organiser: { kind: "madeHere", userId: "u1" as UserId, name: "Sam Rivera" },
    changeable: true,
    people: [],
    takenOff: [],
    answer: null,
    cancelled: false,
    conference: null,
  });
  const events = shownEvents(
    {
      occurrences: [
        occurrence("marketing", timed("Launch", "2026-11-05", "11:00", 60)),
        occurrence("finance", timed("Budget", "2026-11-05", "10:00", 60)),
        occurrence("finance", timed("Payroll", "2026-11-06", "09:00", 60)),
        occurrence("finance", allDay("Audit", "2026-11-05", "2026-11-06")),
      ],
      complete: true,
    },
    [entry("marketing", false), entry("finance", true)],
  );
  const plan = planAt(events, at("2026-11-05", "08:00"));
  expect(plan.next.kind !== "none" && plan.next.event.title).toBe("Launch");
  expect(plan.ahead).toEqual([]);
  expect(plan.allDay).toEqual([]);
  expect(plan.tomorrowEvents).toEqual([]);
  expect(plan.week.flatMap((day) => titles(day.events))).toEqual(["Launch"]);
});

test("the week strip runs Monday to Sunday, with each day's events", () => {
  const plan = planAt(THURSDAY, at("2026-11-05", "10:35"));
  expect(plan.week.map((day) => day.date)).toEqual(
    [
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ].map(date),
  );
  expect(plan.week.map((day) => day.events.length)).toEqual([
    0, 0, 0, 5, 3, 0, 0,
  ]);
});

test("on a Sunday, the events asked for reach into Monday for Tomorrow", () => {
  expect(todayWindow(date("2026-11-08"))).toEqual({
    from: date("2026-11-02"),
    to: date("2026-11-10"),
  });
  expect(todayWindow(date("2026-11-05"))).toEqual({
    from: date("2026-11-02"),
    to: date("2026-11-09"),
  });
});

test("how long until an event starts is rounded up to the minute", () => {
  const start = at("2026-11-05", "11:00");
  expect(untilText(start, start - 30_000)).toBe("in 1 minute");
  expect(untilText(start, start - 59 * MINUTE)).toBe("in 59 minutes");
  expect(untilText(start, start - 60 * MINUTE)).toBe("in 1 hour");
  expect(untilText(start, start - 125 * MINUTE)).toBe("in 2 hours 5 minutes");
});

test("on the night Los Angeles turns its clocks back, Tomorrow and the time until follow the clock", () => {
  const inLosAngeles = (
    title: string,
    day: string,
    clock: string,
    minutes: number,
  ): Shown => {
    const start = at(day, clock, LOS_ANGELES);
    return {
      title,
      time: {
        kind: "timed",
        start,
        end: start + minutes * MINUTE,
        timeZone: LOS_ANGELES,
      },
      cancelled: false,
    };
  };
  const events = [
    inLosAngeles("Early run", "2026-11-01", "03:00", 60),
    inLosAngeles("Late call", "2026-11-01", "23:45", 30),
    inLosAngeles("Monday standup", "2026-11-02", "00:10", 20),
  ];

  // 23:30 to 03:00 on the clock, but 1:00 comes round twice, so it's an hour longer.
  const saturdayNow = at("2026-10-31", "23:30", LOS_ANGELES);
  const saturday = planAt(events, saturdayNow, LOS_ANGELES);
  expect(saturday.tomorrow).toBe(date("2026-11-01"));
  expect(saturday.next.kind).toBe("tomorrow");
  expect(saturday.next.kind !== "none" && saturday.next.event.title).toBe(
    "Early run",
  );
  expect(
    saturday.next.kind !== "none" &&
      untilText(saturday.next.start, saturdayNow),
  ).toBe("in 4 hours 30 minutes");
  expect(titles(saturday.tomorrowEvents)).toEqual(["Late call"]);

  // The 25-hour Sunday still ends at its own midnight.
  const sundayNow = at("2026-11-01", "23:30", LOS_ANGELES);
  const sunday = planAt(events, sundayNow, LOS_ANGELES);
  expect(sunday.today).toBe(date("2026-11-01"));
  expect(sunday.tomorrow).toBe(date("2026-11-02"));
  expect(titles(sunday.finished)).toEqual(["Early run"]);
  expect(sunday.next.kind !== "none" && sunday.next.event.title).toBe(
    "Late call",
  );
  expect(
    sunday.next.kind !== "none" && untilText(sunday.next.start, sundayNow),
  ).toBe("in 15 minutes");
  expect(titles(sunday.tomorrowEvents)).toEqual(["Monday standup"]);
});
