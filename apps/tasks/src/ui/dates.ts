import type { PlainDate } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (value: number) => String(value).padStart(2, "0");

// The device's own calendar day, which decides Overdue and Today.
export const dayOnDevice = (at: number): PlainDate => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` as PlainDate;
};

const utcOf = (date: PlainDate) => Date.parse(`${date}T00:00:00Z`);

export const addDays = (date: PlainDate, days: number) =>
  new Date(utcOf(date) + days * DAY_MS).toISOString().slice(0, 10) as PlainDate;

// Monday is 0, as Calendar's weeks start on Monday.
const weekdayOf = (date: PlainDate) =>
  (new Date(utcOf(date)).getUTCDay() + 6) % 7;

export const sundayOf = (date: PlainDate) => addDays(date, 6 - weekdayOf(date));

const format = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" });

const onDay = (date: PlainDate) => new Date(utcOf(date));

export type DueTone = "overdue" | "today" | "plain";

// "Today", "Tomorrow", "Sunday" within this week, or "Thu 19 Nov", with the year when
// it isn't this one.
export function dueText(
  due: PlainDate,
  today: PlainDate,
): { text: string; tone: DueTone } {
  if (due === today) return { text: "Today", tone: "today" };
  if (due === addDays(today, 1)) return { text: "Tomorrow", tone: "plain" };
  if (due === addDays(today, -1)) return { text: "Yesterday", tone: "overdue" };
  const tone = due < today ? "overdue" : "plain";
  if (due > today && due <= sundayOf(today)) {
    return { text: format({ weekday: "long" }).format(onDay(due)), tone };
  }
  const text = format({
    weekday: "short",
    day: "numeric",
    month: "short",
    year: due.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
  }).format(onDay(due));
  return { text, tone };
}

// "Thursday 12 November", for a page's heading.
export const longDayText = (date: PlainDate) =>
  format({ weekday: "long", day: "numeric", month: "long" }).format(
    onDay(date),
  );
