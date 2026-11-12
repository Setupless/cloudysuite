import { expect, test } from "bun:test";
import { datesOf, ruleOf } from "../repeat";
import { daysIn, visibleDays } from "../schedule";
import { instantOf, parseTimeZone, type WallTime, wallOfDate } from "../time";
import type { CivilDate, EventTime, TimeZone } from "../types";
import {
  layoutMonthWeek,
  layoutTimeGrid,
  MONTH_LINES,
  type Shown,
} from "./schedule-layout";

const zone = (name: string) => parseTimeZone(name) as TimeZone;
const SYDNEY = zone("Australia/Sydney");
const LONDON = zone("Europe/London");
const date = (raw: string) => raw as CivilDate;
const week = (raw: string) =>
  daysIn(visibleDays({ view: "week", date: date(raw) }));

function timed(
  title: string,
  day: string,
  start: string,
  minutes: number,
  where: TimeZone = SYDNEY,
): Shown {
  const [hours, mins] = start.split(":").map(Number) as [number, number];
  const instant = instantOf(
    (wallOfDate(date(day)) + (hours * 60 + mins) * 60_000) as WallTime,
    where,
  );
  return {
    title,
    time: {
      kind: "timed",
      start: instant,
      end: instant + minutes * 60_000,
      timeZone: where,
    },
  };
}

const allDay = (title: string, first: string, after: string): Shown => ({
  title,
  time: { kind: "allDay", startDate: date(first), endDate: date(after) },
});

function weeklyFrom(event: Shown, count: number): Shown[] {
  const rule = ruleOf(
    { frequency: "weekly", end: { kind: "afterTimes", times: count } },
    event.time,
  );
  return [...datesOf(rule, event.time, { steps: 100 })].map(({ time }) => ({
    title: event.title,
    time,
  }));
}

const placedIn = (columns: { item: Shown; startMinute: number }[][]) =>
  columns.flatMap((blocks, day) =>
    blocks.map((block) => ({
      title: block.item.title,
      day,
      startMinute: block.startMinute,
    })),
  );

const lanesOf = (events: Shown[]) =>
  layoutTimeGrid([date("2026-11-05")], events, SYDNEY).columns.flatMap(
    (blocks) =>
      blocks.map(({ item, lane, lanes }) => [item.title, lane, lanes]),
  );

test("overlapping events sit side by side and share the group's width", () => {
  const events = [
    timed("Standup", "2026-11-05", "09:00", 60),
    timed("Review", "2026-11-05", "09:30", 60),
    timed("Interview", "2026-11-05", "10:00", 60),
    timed("Lunch", "2026-11-05", "12:00", 60),
  ];
  expect(lanesOf(events)).toEqual([
    ["Standup", 0, 2],
    ["Review", 1, 2],
    ["Interview", 0, 2],
    ["Lunch", 0, 1],
  ]);
});

test("two short events close together still get a lane each", () => {
  const events = [
    timed("Quick call", "2026-11-05", "14:00", 5),
    timed("Check-in", "2026-11-05", "14:10", 10),
    timed("Later", "2026-11-05", "14:30", 30),
  ];
  expect(lanesOf(events)).toEqual([
    ["Quick call", 0, 2],
    ["Check-in", 1, 2],
    ["Later", 0, 2],
  ]);
});

test("a weekly 9:00 in Sydney stays on the 9:00 line across 4 October", () => {
  const series = weeklyFrom(timed("Planning", "2026-09-24", "09:00", 60), 4);
  const days = [...week("2026-09-24"), ...week("2026-10-01")];
  const lastWeek = [...week("2026-10-05"), ...week("2026-10-12")];
  expect(placedIn(layoutTimeGrid(days, series, SYDNEY).columns)).toEqual([
    { title: "Planning", day: 3, startMinute: 540 },
    { title: "Planning", day: 10, startMinute: 540 },
  ]);
  expect(placedIn(layoutTimeGrid(lastWeek, series, SYDNEY).columns)).toEqual([
    { title: "Planning", day: 3, startMinute: 540 },
    { title: "Planning", day: 10, startMinute: 540 },
  ]);
});

test("the day Sydney skips an hour still lines events up with the clock", () => {
  const sunday = [date("2026-10-04")];
  const events = [
    timed("Early", "2026-10-04", "01:00", 60),
    timed("After the change", "2026-10-04", "03:00", 60),
    timed("Evening", "2026-10-04", "18:00", 60),
  ];
  expect(placedIn(layoutTimeGrid(sunday, events, SYDNEY).columns)).toEqual([
    { title: "Early", day: 0, startMinute: 60 },
    { title: "After the change", day: 0, startMinute: 180 },
    { title: "Evening", day: 0, startMinute: 1080 },
  ]);
});

test("an event set in London shows at the viewer's own time in Sydney", () => {
  const series = weeklyFrom(
    timed("London sync", "2026-10-01", "09:00", 30, LONDON),
    5,
  );
  const days = daysIn({ from: date("2026-10-01"), to: date("2026-10-30") });
  const hours = placedIn(layoutTimeGrid(days, series, SYDNEY).columns).map(
    ({ startMinute }) => startMinute / 60,
  );
  // Sydney moves its clocks on 4 October and London on 25 October.
  expect(hours).toEqual([18, 19, 19, 19, 20]);
});

test("an all-day event stays on its own day in every time zone", () => {
  const christmas = allDay("Christmas Day", "2026-12-25", "2026-12-26");
  for (const name of [
    "Pacific/Kiritimati",
    "Australia/Sydney",
    "UTC",
    "America/Los_Angeles",
    "Pacific/Pago_Pago",
  ]) {
    const viewer = zone(name);
    const { bars, columns } = layoutTimeGrid(
      week("2026-12-21"),
      [christmas],
      viewer,
    );
    expect([name, bars.map(({ first, last }) => [first, last])]).toEqual([
      name,
      [[4, 4]],
    ]);
    expect(columns.flat()).toEqual([]);
    const month = layoutMonthWeek(week("2026-12-21"), [christmas], viewer);
    expect(month.entries.map(({ first, last }) => [first, last])).toEqual([
      [4, 4],
    ]);
  }
});

test("a three-day event is one bar across its days, in Week and in Month", () => {
  const trip = allDay("Trade show", "2026-11-05", "2026-11-08");
  const days = week("2026-11-02");
  const { bars } = layoutTimeGrid(days, [trip], SYDNEY);
  expect(bars).toEqual([
    { item: trip, first: 3, last: 5, row: 0, before: false, after: false },
  ]);
  const { entries } = layoutMonthWeek(days, [trip], SYDNEY);
  expect(entries).toEqual([
    {
      item: trip,
      first: 3,
      last: 5,
      row: 0,
      before: false,
      after: false,
      kind: "bar",
    },
  ]);
});

test("a timed event over several days goes in the all-day row, cut at the week's edge", () => {
  // Saturday 7 November at 9:00 to Tuesday 10 November at 9:00.
  const conference = timed("Conference", "2026-11-07", "09:00", 3 * 24 * 60);
  const { bars, columns } = layoutTimeGrid(
    week("2026-11-02"),
    [conference],
    SYDNEY,
  );
  expect(columns.flat()).toEqual([]);
  expect(
    bars.map(({ first, last, before, after }) => [first, last, before, after]),
  ).toEqual([[5, 6, false, true]]);
  const next = layoutTimeGrid(week("2026-11-09"), [conference], SYDNEY).bars;
  expect(
    next.map(({ first, last, before, after }) => [first, last, before, after]),
  ).toEqual([[0, 1, true, false]]);
});

test("an event that ends at midnight stays in its day's column", () => {
  const late = timed("Late shift", "2026-11-05", "22:00", 120);
  const { bars, columns } = layoutTimeGrid(week("2026-11-02"), [late], SYDNEY);
  expect(bars).toEqual([]);
  expect(
    columns.flatMap((blocks, day) =>
      blocks.map((block) => [day, block.startMinute, block.endMinute]),
    ),
  ).toEqual([[3, 1320, 1440]]);
});

test("bars that overlap take separate lines", () => {
  const days = week("2026-11-02");
  const bars = layoutTimeGrid(
    days,
    [
      allDay("Away", "2026-11-02", "2026-11-05"),
      allDay("Board day", "2026-11-04", "2026-11-05"),
      allDay("Payroll", "2026-11-05", "2026-11-06"),
    ],
    SYDNEY,
  );
  expect(bars.bars.map(({ item, row }) => [item.title, row])).toEqual([
    ["Away", 0],
    ["Board day", 1],
    ["Payroll", 0],
  ]);
  expect(bars.barRows).toBe(2);
});

test("a busy day in Month shows its first lines and counts the rest", () => {
  const days = week("2026-11-02");
  const busy = [
    allDay("Trade show", "2026-11-04", "2026-11-06"),
    timed("Standup", "2026-11-05", "09:30", 15),
    timed("Review", "2026-11-05", "11:00", 60),
    timed("1:1", "2026-11-05", "14:00", 30),
    timed("Invoice run", "2026-11-05", "16:00", 60),
  ];
  const { entries, hidden } = layoutMonthWeek(days, busy, SYDNEY);
  expect(
    entries.map(({ item, first, row, kind }) => [item.title, first, row, kind]),
  ).toEqual([
    ["Trade show", 2, 0, "bar"],
    ["Standup", 3, 1, "timed"],
    ["Review", 3, 2, "timed"],
  ]);
  expect(MONTH_LINES).toBe(3);
  expect(hidden).toEqual([0, 0, 0, 2, 0, 0, 0]);
});

test("Month leaves out events outside the days shown", () => {
  const time: EventTime = {
    kind: "allDay",
    startDate: date("2026-10-20"),
    endDate: date("2026-10-21"),
  };
  expect(
    layoutMonthWeek(week("2026-11-02"), [{ title: "Gone", time }], SYDNEY)
      .entries,
  ).toEqual([]);
});

test("a task on its day comes after that day's all-day events, whatever its title", () => {
  const days = week("2026-11-09");
  const task = {
    ...allDay("Book flights", "2026-11-12", "2026-11-13"),
    trailing: true,
  };
  const items = [task, allDay("Team offsite", "2026-11-12", "2026-11-13")];
  const rows = (layout: { item: Shown; row: number }[]) =>
    layout.map(({ item, row }) => [item.title, row]);
  expect(rows(layoutTimeGrid(days, items, SYDNEY).bars)).toEqual([
    ["Team offsite", 0],
    ["Book flights", 1],
  ]);
  expect(rows(layoutMonthWeek(days, items, SYDNEY).entries)).toEqual([
    ["Team offsite", 0],
    ["Book flights", 1],
  ]);
});

test("a task stays below an all-day event over its day after an earlier event ends", () => {
  const days = week("2026-11-09");
  const task = {
    ...allDay("Book flights", "2026-11-10", "2026-11-11"),
    trailing: true,
  };
  const items = [
    allDay("Event A", "2026-11-08", "2026-11-10"),
    allDay("Event B", "2026-11-09", "2026-11-12"),
    task,
  ];
  const rows = (layout: { item: Shown; row: number }[]) =>
    layout.map(({ item, row }) => [item.title, row]);
  const expected = [
    ["Event A", 0],
    ["Event B", 1],
    ["Book flights", 2],
  ];
  expect(rows(layoutTimeGrid(days, items, SYDNEY).bars)).toEqual(expected);
  expect(rows(layoutMonthWeek(days, items, SYDNEY).entries)).toEqual(expected);
});
