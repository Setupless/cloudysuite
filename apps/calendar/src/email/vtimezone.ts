import ICAL from "ical.js";
import { DAY_MS, wallOf } from "../time";
import type { TimeZone } from "../types";

// ical.js knows no zones of its own, so a VTIMEZONE is worked out from the runtime's.

const MINUTE_MS = 60_000;
// Enough for a rule like Israel's, the Friday before the last Sunday, to stop matching
// the fourth Friday or the last one.
const YEARS_CHECKED = 8;
// Around the event, for a zone whose changes follow no yearly rule.
const YEARS_BEFORE = 1;
const YEARS_AFTER = 5;

type Change = { at: number; from: number; to: number };

const offsetAt = (zone: TimeZone, instant: number) =>
  wallOf(instant, zone) - instant;

// Every change of offset in one year, to the minute.
function changesIn(zone: TimeZone, year: number): Change[] {
  const changes: Change[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let before = Date.UTC(year, 0, 1);
  let offset = offsetAt(zone, before);
  for (let at = before + DAY_MS; at <= end; at += DAY_MS) {
    const next = offsetAt(zone, at);
    if (next !== offset) {
      let low = before;
      let high = at;
      while (high - low > MINUTE_MS) {
        const middle =
          low + Math.floor((high - low) / MINUTE_MS / 2) * MINUTE_MS;
        if (offsetAt(zone, middle) === offset) low = middle;
        else high = middle;
      }
      changes.push({ at: high, from: offset, to: next });
      offset = next;
    }
    before = at;
  }
  return changes;
}

// A change as a yearly rule, such as the first Sunday of April at 03:00 on the clock
// before the change. The week is -1 for the last one in the month.
type Rule = {
  month: number;
  weekday: number;
  week: number;
  minute: number;
  from: number;
  to: number;
};

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

function rulesOf(change: Change): Rule[] {
  const local = new Date(change.at + change.from);
  const day = local.getUTCDate();
  const base = {
    month: local.getUTCMonth() + 1,
    weekday: local.getUTCDay(),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
    from: change.from,
    to: change.to,
  };
  const week = Math.ceil(day / 7);
  const last = day + 7 > daysInMonth(local.getUTCFullYear(), base.month);
  return [
    ...(week <= 4 ? [{ ...base, week }] : []),
    ...(last ? [{ ...base, week: -1 }] : []),
  ];
}

const sameRule = (a: Rule, b: Rule) => JSON.stringify(a) === JSON.stringify(b);

// The two changes a year as rules that every year checked agrees on, or null when the
// zone follows no such pattern.
function yearlyRules(zone: TimeZone, year: number): Rule[] | null {
  const years = Array.from({ length: YEARS_CHECKED }, (_, index) =>
    changesIn(zone, year + index),
  );
  if (years.some((changes) => changes.length !== 2)) return null;
  const rules: Rule[] = [];
  for (const index of [0, 1]) {
    const candidates = rulesOf(years[0]![index]!).filter((rule) =>
      years.every((changes) =>
        changes.some((change) =>
          rulesOf(change).some((other) => sameRule(rule, other)),
        ),
      ),
    );
    if (candidates.length === 0) return null;
    rules.push(candidates[0]!);
  }
  return rules;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// The rule's date in 1970, as other calendars write it, since the rule stands for every
// year it covers.
function firstIn1970(rule: Rule): ICAL.Time {
  const days = daysInMonth(1970, rule.month);
  const firstWeekday = new Date(Date.UTC(1970, rule.month - 1, 1)).getUTCDay();
  const firstMatch = 1 + ((rule.weekday - firstWeekday + 7) % 7);
  const day =
    rule.week === -1
      ? firstMatch + Math.floor((days - firstMatch) / 7) * 7
      : firstMatch + (rule.week - 1) * 7;
  return ICAL.Time.fromData({
    year: 1970,
    month: rule.month,
    day,
    hour: Math.floor(rule.minute / 60),
    minute: rule.minute % 60,
    second: 0,
  });
}

const localTimeOf = (instant: number) => {
  const local = new Date(instant);
  return ICAL.Time.fromData({
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: 0,
  });
};

function observance(
  start: ICAL.Time,
  from: number,
  to: number,
  daylight: boolean,
  rule?: Rule,
): ICAL.Component {
  const part = new ICAL.Component(daylight ? "daylight" : "standard");
  part.addPropertyWithValue("dtstart", start);
  part.addPropertyWithValue(
    "tzoffsetfrom",
    ICAL.UtcOffset.fromSeconds(from / 1000),
  );
  part.addPropertyWithValue(
    "tzoffsetto",
    ICAL.UtcOffset.fromSeconds(to / 1000),
  );
  if (rule) {
    part.addPropertyWithValue(
      "rrule",
      ICAL.Recur.fromString(
        `FREQ=YEARLY;BYMONTH=${rule.month};BYDAY=${rule.week}${WEEKDAYS[rule.weekday]}`,
      ),
    );
  }
  return part;
}

// Each email about an event in a zone needs the same description, so it's worked out once.
const described = new Map<string, string>();

// `around` is an instant the event has, whose year the description starts from.
export function timeZoneComponent(
  zone: TimeZone,
  around: number,
): ICAL.Component {
  const key = `${zone} ${new Date(around).getUTCFullYear()}`;
  let text = described.get(key);
  if (text === undefined) {
    text = describe(zone, around).toString();
    described.set(key, text);
  }
  return new ICAL.Component(ICAL.parse(text));
}

function describe(zone: TimeZone, around: number): ICAL.Component {
  const component = new ICAL.Component("vtimezone");
  component.addPropertyWithValue("tzid", zone);
  const year = new Date(around).getUTCFullYear();
  const rules = yearlyRules(zone, year);
  if (rules) {
    const daylight = Math.max(rules[0]!.to, rules[1]!.to);
    for (const rule of rules) {
      component.addSubcomponent(
        observance(
          firstIn1970(rule),
          rule.from,
          rule.to,
          rule.to === daylight,
          rule,
        ),
      );
    }
    return component;
  }
  // A zone that never changes has no changes here, and so only this.
  const epoch = ICAL.Time.fromData({
    year: 1970,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const first = year - YEARS_BEFORE;
  const changes = Array.from(
    { length: YEARS_BEFORE + YEARS_AFTER + 1 },
    (_, index) => changesIn(zone, first + index),
  ).flat();
  const opening = offsetAt(zone, Date.UTC(first, 0, 1));
  component.addSubcomponent(observance(epoch, opening, opening, false));
  for (const change of changes) {
    component.addSubcomponent(
      observance(
        localTimeOf(change.at + change.from),
        change.from,
        change.to,
        change.to > change.from,
      ),
    );
  }
  return component;
}
