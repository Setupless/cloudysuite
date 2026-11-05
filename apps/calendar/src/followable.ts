// ical.js can loop forever inside one call on a rule that never matches, such as every
// day of February that is the 30th, and no budget can stop a call that never returns.
// It also throws on some rules, and puts others on the wrong dates. So a rule reaches it
// only in one of the shapes below, each of which has a date in every day, week, month,
// or year it steps through, or stops by itself after a bounded number of empty ones.

const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const PART_NAMES = [
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "WKST",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "BYSETPOS",
] as const;

const MAX_RULE_LENGTH = 300;
const MAX_LIST_LENGTH = 31;
// Each step of ical.js walks this many days one at a time for a weekly rule, times 7.
const MAX_INTERVAL = 999;
// Every month has at least four of each weekday.
const WEEKDAYS_IN_ANY_MONTH = 4;
const SHORTEST_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

type Frequency = (typeof FREQUENCIES)[number];
type Weekday = (typeof WEEKDAYS)[number];
type PartName = (typeof PART_NAMES)[number];

// A null ordinal is every one of that weekday in the period.
type DayRule = { ordinal: number | null; weekday: Weekday };

export type FollowableRule = {
  frequency: Frequency;
  interval: number;
  byDay: DayRule[] | null;
  byMonthDay: number[] | null;
  byMonth: number[] | null;
  bySetPos: number[] | null;
};

type Selector = "byDay" | "byMonthDay" | "byMonth" | "bySetPos";

const DIGITS = /^[+-]?\d{1,3}$/;
const DAY = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/;
const UNTIL = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/;
const PIECE = /^([A-Z]+)=([A-Z0-9,+-]+)$/;

function readParts(rule: string): Map<PartName, string> | null {
  if (rule.length > MAX_RULE_LENGTH) return null;
  const parts = new Map<PartName, string>();
  for (const piece of rule.split(";")) {
    const match = PIECE.exec(piece);
    const name = match?.[1] as PartName | undefined;
    if (!match || !name || !PART_NAMES.includes(name) || parts.has(name)) {
      return null;
    }
    parts.set(name, match[2] as string);
  }
  return parts;
}

function wholeNumber(raw: string, least: number, most: number): number | null {
  if (!/^\d{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= least && value <= most ? value : null;
}

// Distinct signed numbers whose size is from 1 to `most`.
function signedList(raw: string, most: number): number[] | null {
  const values = raw.split(",");
  if (values.length > MAX_LIST_LENGTH) return null;
  const numbers = values.map((value) =>
    DIGITS.test(value) ? Number(value) : 0,
  );
  const fits = numbers.every((n) => n !== 0 && Math.abs(n) <= most);
  return fits && new Set(numbers).size === numbers.length ? numbers : null;
}

function dayList(raw: string): DayRule[] | null {
  const values = raw.split(",");
  if (values.length > MAX_LIST_LENGTH) return null;
  const days: DayRule[] = [];
  for (const value of values) {
    const match = DAY.exec(value);
    if (!match) return null;
    const ordinal = match[1] === undefined ? null : Number(match[1]);
    if (ordinal === 0) return null;
    days.push({ ordinal, weekday: match[2] as Weekday });
  }
  const keys = new Set(days.map((day) => `${day.ordinal}${day.weekday}`));
  return keys.size === days.length ? days : null;
}

function realUntil(raw: string): boolean {
  const match = UNTIL.exec(raw);
  if (!match) return false;
  const [year, month, day, hour = 0, minute = 0, second = 0] = match
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part))) as number[];
  const instant = new Date(
    Date.UTC(
      year as number,
      (month as number) - 1,
      day as number,
      hour,
      minute,
      second,
    ),
  );
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === (month as number) - 1 &&
    instant.getUTCDate() === day &&
    instant.getUTCHours() === hour &&
    instant.getUTCMinutes() === minute &&
    instant.getUTCSeconds() === second
  );
}

function read(rule: string): FollowableRule | null {
  const parts = readParts(rule);
  if (!parts) return null;
  const frequency = FREQUENCIES.find((name) => name === parts.get("FREQ"));
  if (!frequency) return null;
  const interval = parts.has("INTERVAL")
    ? wholeNumber(parts.get("INTERVAL") as string, 1, MAX_INTERVAL)
    : 1;
  const count = parts.get("COUNT");
  const until = parts.get("UNTIL");
  const wkst = parts.get("WKST");
  if (
    interval === null ||
    (count !== undefined && until !== undefined) ||
    (count !== undefined && wholeNumber(count, 1, 999_999) === null) ||
    (until !== undefined && !realUntil(until)) ||
    (wkst !== undefined && !WEEKDAYS.includes(wkst as Weekday))
  ) {
    return null;
  }
  const list = <Value>(
    name: PartName,
    parse: (raw: string) => Value[] | null,
  ): Value[] | null | undefined => {
    const raw = parts.get(name);
    return raw === undefined ? null : (parse(raw) ?? undefined);
  };
  const byDay = list("BYDAY", dayList);
  const byMonthDay = list("BYMONTHDAY", (raw) => signedList(raw, 31));
  const byMonth = list("BYMONTH", (raw) => {
    const months = signedList(raw, 12);
    return months && months.every((month) => month > 0) ? months : null;
  });
  const bySetPos = list("BYSETPOS", (raw) => signedList(raw, 366));
  if (
    byDay === undefined ||
    byMonthDay === undefined ||
    byMonth === undefined ||
    bySetPos === undefined
  ) {
    return null;
  }
  return { frequency, interval, byDay, byMonthDay, byMonth, bySetPos };
}

const SELECTORS: readonly Selector[] = [
  "byDay",
  "byMonthDay",
  "byMonth",
  "bySetPos",
];

// The selectors named are all present, and no other is.
const exactly = (rule: FollowableRule, ...names: Selector[]) =>
  SELECTORS.every((name) => (rule[name] !== null) === names.includes(name));

const everyWeekday = (days: DayRule[]) =>
  days.every((day) => day.ordinal === null);

// "The second Tuesday" exists in every month up to the fourth. A fifth one only exists
// in some months, so ical.js may step through many before it finds one, and forever if
// the interval only ever lands on February.
const nthWeekdays = (days: DayRule[], furthest: number) =>
  days.every(
    (day) => day.ordinal !== null && Math.abs(day.ordinal) <= furthest,
  );

const inEverySet = (positions: number[], days: DayRule[], months = 1) =>
  positions.every(
    (position) =>
      Math.abs(position) <= WEEKDAYS_IN_ANY_MONTH * days.length * months,
  );

// ical.js moves a day that a month lacks into the next month, and counts a day from the
// end of the wrong month, so every day named must count from the start and exist in
// every month named, in every year.
const inEveryMonth = (days: number[], months: number[]) =>
  months.every((month) =>
    days.every(
      (day) => day > 0 && day <= (SHORTEST_MONTH[month - 1] as number),
    ),
  );

const SHAPES: Record<Frequency, (rule: FollowableRule) => boolean> = {
  DAILY: (rule) =>
    exactly(rule) ||
    (exactly(rule, "byDay") &&
      rule.interval === 1 &&
      everyWeekday(rule.byDay as DayRule[])),
  WEEKLY: (rule) =>
    exactly(rule) ||
    (exactly(rule, "byDay") && everyWeekday(rule.byDay as DayRule[])),
  MONTHLY: (rule) => {
    const days = rule.byDay as DayRule[];
    return (
      exactly(rule) ||
      exactly(rule, "byMonthDay") ||
      (exactly(rule, "byDay") &&
        (everyWeekday(days) ||
          nthWeekdays(days, rule.interval === 1 ? 5 : 4))) ||
      (exactly(rule, "byDay", "bySetPos") &&
        everyWeekday(days) &&
        inEverySet(rule.bySetPos as number[], days))
    );
  },
  YEARLY: (rule) => {
    const days = rule.byDay as DayRule[];
    const months = rule.byMonth as number[];
    return (
      exactly(rule) ||
      (exactly(rule, "byMonth", "byMonthDay") &&
        inEveryMonth(rule.byMonthDay as number[], months)) ||
      (exactly(rule, "byMonth", "byDay") &&
        (everyWeekday(days) || nthWeekdays(days, 4))) ||
      (exactly(rule, "byMonth", "byDay", "bySetPos") &&
        months.length === 1 &&
        everyWeekday(days) &&
        inEverySet(rule.bySetPos as number[], days))
    );
  },
};

// The rule as Calendar reads it, or null if ical.js mustn't be asked for its dates.
export function followableRule(rule: string): FollowableRule | null {
  const parsed = read(rule);
  return parsed && SHAPES[parsed.frequency](parsed) ? parsed : null;
}
