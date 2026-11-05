import { expect, test } from "bun:test";
import {
  defaultParseSearch,
  defaultStringifySearch,
} from "@tanstack/react-router";
import {
  type OccurrenceKey,
  parseScheduleSearch,
  type SchedulePlace,
  searchOf,
  steppedDate,
  visibleDays,
} from "./schedule";
import type { CivilDate } from "./types";

const date = (raw: string) => raw as CivilDate;
const place = (view: SchedulePlace["view"], raw: string): SchedulePlace => ({
  view,
  date: date(raw),
});

const throughAddress = (search: ReturnType<typeof searchOf>) => {
  const address = defaultStringifySearch(search);
  return {
    address,
    back: parseScheduleSearch(
      defaultParseSearch(address) as Record<string, unknown>,
    ),
  };
};

test("the view, date, and open event come back the same from the address", () => {
  const event = "cal_1/20261004T220000Z/uid-1@example.org" as OccurrenceKey;
  for (const search of [
    searchOf("day", date("2026-10-04"), event),
    searchOf("week", date("2026-10-04")),
    searchOf("month", date("2026-04-05")),
    searchOf("week", undefined),
  ]) {
    expect(throughAddress(search).back).toEqual(search);
  }
  expect(throughAddress(searchOf("day", date("2026-10-04"))).address).toBe(
    "?view=day&date=2026-10-04",
  );
});

test("the bare address is this week, and Week adds nothing to it", () => {
  expect(throughAddress(searchOf("week", undefined)).address).toBe("");
});

test("an address with a wrong part opens the default for that part", () => {
  expect(
    parseScheduleSearch({ view: "year", date: "2026-02-30", event: "x" }),
  ).toEqual({});
  expect(parseScheduleSearch({ view: "month", event: "x" })).toEqual({
    view: "month",
  });
});

test("Day, Week, and Month cover whole days across Sydney's change on 4 October", () => {
  expect(visibleDays(place("day", "2026-10-04"))).toEqual({
    from: date("2026-10-04"),
    to: date("2026-10-05"),
  });
  expect(visibleDays(place("week", "2026-10-04"))).toEqual({
    from: date("2026-09-28"),
    to: date("2026-10-05"),
  });
  expect(visibleDays(place("month", "2026-10-04"))).toEqual({
    from: date("2026-09-28"),
    to: date("2026-11-02"),
  });
});

test("previous and next move by a day, a week, or a month", () => {
  expect(steppedDate(place("day", "2026-10-04"), -1)).toBe(date("2026-10-03"));
  expect(steppedDate(place("week", "2026-10-01"), 1)).toBe(date("2026-10-08"));
  expect(
    visibleDays(place("week", steppedDate(place("week", "2026-10-01"), 1))),
  ).toEqual({ from: date("2026-10-05"), to: date("2026-10-12") });
  expect(steppedDate(place("month", "2026-10-04"), 1)).toBe(date("2026-11-04"));
  expect(steppedDate(place("month", "2026-03-31"), -1)).toBe(
    date("2026-02-28"),
  );
  expect(steppedDate(place("month", "2026-12-15"), 1)).toBe(date("2027-01-15"));
});

test("Month shows every week that holds one of its days", () => {
  expect(visibleDays(place("month", "2026-02-10"))).toEqual({
    from: date("2026-01-26"),
    to: date("2026-03-02"),
  });
  expect(visibleDays(place("month", "2026-11-20"))).toEqual({
    from: date("2026-10-26"),
    to: date("2026-12-07"),
  });
});
