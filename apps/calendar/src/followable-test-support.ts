// followable.test.ts runs this as a child process with a time limit, because a rule that
// hangs ical.js would otherwise hang the test runner, which can't stop a loop.
//   bun followable-test-support.ts hostile
//   bun followable-test-support.ts fuzz <seed> <cases>
import { applyMigrations } from "@cloudysuite/object-sql";
import { createSqlDriver } from "@cloudysuite/object-sql/test-driver";
import type { UserId } from "@cloudysuite/access";
import { type FollowableRule, followableRule } from "./followable";
import { MIGRATIONS } from "./migrations";
import { readCalendarFile } from "./outside/ics";
import { HOSTILE_RULES, withRule } from "./outside/test-support";
import { datesOf } from "./repeat";
import { EventStore, groupForImport } from "./store";
import type { CivilDate, EventTime, TimeZone } from "./types";

const SYDNEY = "Australia/Sydney" as TimeZone;
const DAY = 86_400_000;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const MANAGER = { userId: "user-manager" as UserId, role: "manager" as const };

const print = (value: unknown) => console.log(JSON.stringify(value));

const localStart = (instant: number) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: SYDNEY,
    dateStyle: "short",
    timeStyle: "short",
  }).format(instant);

function hostile() {
  for (const rule of HOSTILE_RULES) {
    print({ running: rule });
    const { db } = createSqlDriver();
    applyMigrations(db, MIGRATIONS);
    const store = new EventStore(db);
    const began = performance.now();
    const reading = readCalendarFile(withRule(rule), SYDNEY);
    if (reading.status !== "read") throw new Error(reading.status);
    const imported = store.importEvents(
      MANAGER,
      "Sam Rivera",
      groupForImport(reading.events),
      0,
    );
    const listing = store.listRange(MANAGER, {
      from: "2026-01-01" as CivilDate,
      to: "2028-01-01" as CivilDate,
      timeZone: SYDNEY,
    });
    print({
      rule,
      followable: followableRule(rule) !== null,
      imported,
      shown: listing.occurrences.map((occurrence) =>
        occurrence.time.kind === "timed"
          ? localStart(occurrence.time.start)
          : occurrence.time.startDate,
      ),
      repeat: listing.occurrences[0]?.repeat,
      milliseconds: Math.round(performance.now() - began),
    });
  }
}

// RFC 5545 worked out by brute force, a day at a time, for the shapes Calendar follows.
type Rule = FollowableRule & { weekStart: number };

const dayOf = (wall: number) => new Date(wall).toISOString().slice(0, 10);
const weekdayOf = (wall: number) => (new Date(wall).getUTCDay() + 6) % 7;
const daysIn = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

function selects(rule: Rule, wall: number, start: number): boolean {
  const date = new Date(wall);
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const length = daysIn(date.getUTCFullYear(), month);
  const first = new Date(start);
  if (rule.byMonth && !rule.byMonth.includes(month)) return false;
  if (
    rule.byMonthDay &&
    !rule.byMonthDay.some((n) => (n > 0 ? n : length + n + 1) === day)
  ) {
    return false;
  }
  if (rule.byDay) {
    const weekday = WEEKDAYS[weekdayOf(wall)];
    const fromStart = Math.ceil(day / 7);
    const fromEnd = -Math.ceil((length - day + 1) / 7);
    return rule.byDay.some(
      (entry) =>
        entry.weekday === weekday &&
        (entry.ordinal === null ||
          entry.ordinal === fromStart ||
          entry.ordinal === fromEnd),
    );
  }
  if (rule.byMonthDay) return true;
  switch (rule.frequency) {
    case "DAILY":
      return true;
    case "WEEKLY":
      return weekdayOf(wall) === weekdayOf(start);
    case "MONTHLY":
      return day === first.getUTCDate();
    case "YEARLY":
      return day === first.getUTCDate() && month === first.getUTCMonth() + 1;
  }
}

function periodOf(rule: Rule, wall: number, start: number): number {
  const date = new Date(wall);
  const first = new Date(start);
  const months = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  const weekOf = (w: number) =>
    w - ((((weekdayOf(w) - rule.weekStart) % 7) + 7) % 7) * DAY;
  switch (rule.frequency) {
    case "DAILY":
      return Math.round((wall - start) / DAY);
    case "WEEKLY":
      return Math.round((weekOf(wall) - weekOf(start)) / DAY / 7);
    case "MONTHLY":
      return months(date) - months(first);
    case "YEARLY":
      return date.getUTCFullYear() - first.getUTCFullYear();
  }
}

function inSetPosition(rule: Rule, wall: number, start: number): boolean {
  if (!rule.bySetPos) return true;
  const date = new Date(wall);
  const year = date.getUTCFullYear();
  const [from, to] =
    rule.frequency === "MONTHLY"
      ? [
          Date.UTC(year, date.getUTCMonth(), 1),
          Date.UTC(year, date.getUTCMonth() + 1, 1),
        ]
      : [Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)];
  const set: number[] = [];
  for (let day = from; day < to; day += DAY) {
    if (selects(rule, day, start)) set.push(day);
  }
  return rule.bySetPos.some(
    (position) =>
      (position > 0 ? set[position - 1] : set[set.length + position]) === wall,
  );
}

const HORIZON = 80 * 365 * DAY;

function expected(rule: Rule, start: number, count: number): string[] {
  const dates: string[] = [];
  for (let wall = start; wall < start + HORIZON; wall += DAY) {
    if (
      periodOf(rule, wall, start) % rule.interval === 0 &&
      selects(rule, wall, start) &&
      inSetPosition(rule, wall, start)
    ) {
      dates.push(dayOf(wall));
      if (dates.length === count) break;
    }
  }
  return dates;
}

// A start the rule itself would pick, as Google, Outlook, and Apple always write.
function firstDateFrom(rule: Rule, from: number): number | null {
  for (let wall = from; wall < from + 30 * 366 * DAY; wall += DAY) {
    if (expected(rule, wall, 1)[0] === dayOf(wall)) return wall;
  }
  return null;
}

function fuzz(seed: number, cases: number) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(random() * list.length)] as T;
  const some = <T>(list: readonly T[], most: number) => {
    const left = [...list];
    const chosen: T[] = [];
    const wanted = 1 + Math.floor(random() * most);
    while (chosen.length < wanted && left.length > 0) {
      chosen.push(left.splice(Math.floor(random() * left.length), 1)[0] as T);
    }
    return chosen.join(",");
  };
  const weekdays = () => some(WEEKDAYS, 7);
  const nthWeekdays = () =>
    some(WEEKDAYS, 3)
      .split(",")
      .map((day) => `${pick([1, 2, 3, 4, 5, -1, -2, -3, -4, -5])}${day}`)
      .join(",");
  const monthDays = () =>
    some([1, 2, 13, 15, 28, 29, 30, 31, -1, -2, -28, -29, -30, -31], 3);
  const months = () => some([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 3);
  const selectors = [
    () => [],
    () => [`BYDAY=${random() < 0.5 ? weekdays() : nthWeekdays()}`],
    () => [`BYMONTHDAY=${monthDays()}`],
    () => [`BYMONTH=${months()}`, `BYMONTHDAY=${monthDays()}`],
    () => [
      `BYMONTH=${months()}`,
      `BYDAY=${random() < 0.5 ? weekdays() : nthWeekdays()}`,
    ],
    () => [`BYDAY=${weekdays()}`, `BYSETPOS=${pick([1, 2, 4, -1, -2, 5, 20])}`],
    () => [
      `BYMONTH=${months()}`,
      `BYDAY=${weekdays()}`,
      `BYSETPOS=${pick([1, 2, -1, 4, 9])}`,
    ],
  ];

  let followed = 0;
  const disagreements: unknown[] = [];
  for (let index = 0; index < cases; index++) {
    const text = [
      `FREQ=${pick(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"])}`,
      ...(random() < 0.5
        ? [`INTERVAL=${pick([1, 2, 3, 5, 7, 12, 13, 24, 48, 100])}`]
        : []),
      ...(random() < 0.3 ? [`WKST=${pick(WEEKDAYS)}`] : []),
      ...pick(selectors)(),
    ].join(";");
    print({ running: text });
    const parsed = followableRule(text);
    if (!parsed) continue;
    followed++;
    const weekStart = /WKST=(\w\w)/.exec(text)?.[1];
    const rule = {
      ...parsed,
      weekStart: weekStart ? WEEKDAYS.indexOf(weekStart) : 0,
    };
    const from = Date.UTC(
      2020 + Math.floor(random() * 10),
      Math.floor(random() * 12),
      1 + Math.floor(random() * 28),
    );
    // Any start at all must still come back, even one the rule wouldn't pick.
    const unaligned: EventTime = {
      kind: "timed",
      start: from,
      end: from + 3_600_000,
      timeZone: SYDNEY,
    };
    let count = 0;
    for (const _ of datesOf(text, unaligned, { steps: 200 })) count++;

    const start = firstDateFrom(rule, from);
    if (start === null) continue;
    const time: EventTime = {
      kind: "allDay",
      startDate: dayOf(start) as CivilDate,
      endDate: dayOf(start + DAY) as CivilDate,
    };
    const got: string[] = [];
    for (const date of datesOf(text, time, { steps: 100_000 })) {
      if (date.time.kind === "allDay") got.push(date.time.startDate);
      if (got.length === 25) break;
    }
    const want = expected(rule, start, 25);
    const horizon = dayOf(start + HORIZON);
    const compared = want.length < 25 ? got.filter((d) => d < horizon) : got;
    if (JSON.stringify(compared) !== JSON.stringify(want)) {
      disagreements.push({ text, start: dayOf(start), want, got });
    }
  }
  print({ cases, followed, disagreements });
}

const [mode, seed, cases] = process.argv.slice(2);
if (mode === "hostile") hostile();
else fuzz(Number(seed), Number(cases));
