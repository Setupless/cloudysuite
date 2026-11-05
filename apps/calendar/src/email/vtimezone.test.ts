import { expect, test } from "bun:test";
import ICAL from "ical.js";
import { DAY_MS, wallOf } from "../time";
import type { TimeZone } from "../types";
import { timeZoneComponent } from "./vtimezone";

const AROUND = Date.parse("2026-11-10T00:00:00Z");

// What another calendar reads from the description, against what this runtime says,
// at noon UTC on every day from a year before to five years after.
function mismatches(zone: TimeZone): string[] {
  const vtimezone = timeZoneComponent(zone, AROUND);
  const reader = new ICAL.Timezone({ component: vtimezone, tzid: zone });
  const wrong: string[] = [];
  const start = Date.parse("2025-01-01T12:00:00Z");
  for (let at = start; at < start + 6 * 365 * DAY_MS; at += DAY_MS) {
    const wall = new Date(wallOf(at, zone));
    const local = ICAL.Time.fromData({
      year: wall.getUTCFullYear(),
      month: wall.getUTCMonth() + 1,
      day: wall.getUTCDate(),
      hour: wall.getUTCHours(),
      minute: wall.getUTCMinutes(),
      second: 0,
    });
    const expected = (wallOf(at, zone) - at) / 1000;
    const read = reader.utcOffset(local);
    if (read !== expected)
      wrong.push(`${new Date(at).toISOString()} ${read} ${expected}`);
  }
  return wrong;
}

for (const zone of [
  "Australia/Sydney",
  "Europe/London",
  "America/New_York",
  "Pacific/Auckland",
  "America/Santiago",
  "Pacific/Chatham",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "UTC",
  "Africa/Casablanca",
  "Asia/Jerusalem",
  "America/Sao_Paulo",
]) {
  test(`another calendar reads ${zone}'s offsets as this runtime does`, () => {
    expect(mismatches(zone as TimeZone)).toEqual([]);
  });
}

test("a zone with daylight saving is written as two yearly rules", () => {
  const text = timeZoneComponent(
    "Australia/Sydney" as TimeZone,
    AROUND,
  ).toString();
  expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU");
  expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU");
});
