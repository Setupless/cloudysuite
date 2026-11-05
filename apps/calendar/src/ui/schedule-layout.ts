import {
  addDays,
  daysBetween,
  dateOfWall,
  startOfDay,
  wallOf,
  wallOfDate,
} from "../time";
import type { CivilDate, EventTime, TimeZone } from "../types";

const MINUTE_MS = 60_000;

// A shorter event still draws this long, so it's big enough to click, and the lanes
// count it at this length so nothing covers it.
export const SHORTEST_MINUTES = 30;

export const MONTH_LINES = 3;

export type Shown = { time: EventTime; title: string };

// The days an event covers on the viewer's calendar, the last one included.
export type DaySpan = { first: CivilDate; last: CivilDate };

export type Lane = { lane: number; lanes: number };

// A timed event inside one day's column, in minutes after that day's midnight on the
// viewer's clock.
export type Block<Item> = Lane & {
  item: Item;
  startMinute: number;
  endMinute: number;
};

// An event drawn across whole days: all day, or spanning more than one day. `first` and
// `last` count days from the first one shown.
export type Bar<Item> = {
  item: Item;
  first: number;
  last: number;
  row: number;
  // It started before the first day shown, or goes on after the last one.
  before: boolean;
  after: boolean;
};

export type TimeGridLayout<Item> = {
  columns: Block<Item>[][];
  bars: Bar<Item>[];
  barRows: number;
};

export type MonthEntry<Item> = Bar<Item> & { kind: "bar" | "timed" };

export type MonthWeekLayout<Item> = {
  // Only the ones on the lines shown.
  entries: MonthEntry<Item>[];
  // For each day, how many of its events didn't fit.
  hidden: number[];
};

// An all-day event is a date, so it keeps its own dates in every time zone. A timed
// event's end is the first moment after it, so one that ends at midnight stays on its day.
export function daySpanOf(time: EventTime, zone: TimeZone): DaySpan {
  if (time.kind === "allDay") {
    return { first: time.startDate, last: addDays(time.endDate, -1) };
  }
  return {
    first: dateOfWall(wallOf(time.start, zone)),
    last: dateOfWall(wallOf(Math.max(time.start, time.end - 1), zone)),
  };
}

// Each item takes the first lane that's free when it starts. Items that overlap, directly
// or through others, form a group that shares one lane count, so their widths line up.
// Items that start together keep the order they came in.
export function packLanes<Item>(
  items: readonly Item[],
  startOf: (item: Item) => number,
  endOf: (item: Item) => number,
): Map<Item, Lane> {
  const placed = new Map<Item, Lane>();
  let group: Lane[] = [];
  let laneEnds: number[] = [];
  let groupEnd = Number.NEGATIVE_INFINITY;
  const closeGroup = () => {
    for (const lane of group) lane.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
    groupEnd = Number.NEGATIVE_INFINITY;
  };
  for (const item of [...items].sort((a, b) => startOf(a) - startOf(b))) {
    const start = startOf(item);
    const end = endOf(item);
    if (start >= groupEnd) closeGroup();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = end;
    const placement = { lane, lanes: 0 };
    placed.set(item, placement);
    group.push(placement);
    groupEnd = Math.max(groupEnd, end);
  }
  closeGroup();
  return placed;
}

// Soonest first on the viewer's clock, then the longer one, so a long bar takes the top
// line and the shorter events fit under it.
function inShownOrder<Item extends Shown>(
  items: readonly Item[],
  zone: TimeZone,
) {
  const startOf = (time: EventTime) =>
    time.kind === "allDay" ? startOfDay(time.startDate, zone) : time.start;
  const endOf = (time: EventTime) =>
    time.kind === "allDay" ? startOfDay(time.endDate, zone) : time.end;
  return [...items].sort(
    (a, b) =>
      startOf(a.time) - startOf(b.time) ||
      endOf(b.time) - endOf(a.time) ||
      a.title.localeCompare(b.title),
  );
}

type Spanned<Item> = { item: Item; span: DaySpan };

function spannedIn<Item extends Shown>(
  days: readonly CivilDate[],
  items: readonly Item[],
  zone: TimeZone,
): Spanned<Item>[] {
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) return [];
  return inShownOrder(items, zone).flatMap((item) => {
    const span = daySpanOf(item.time, zone);
    return span.last < first || span.first > last ? [] : [{ item, span }];
  });
}

const isBar = ({ item, span }: Spanned<Shown>) =>
  item.time.kind === "allDay" || span.first !== span.last;

function barsOf<Item>(
  days: readonly CivilDate[],
  spanned: readonly Spanned<Item>[],
): Bar<Item>[] {
  const firstDay = days[0] as CivilDate;
  const lastIndex = days.length - 1;
  const bars = spanned.map(({ item, span }) => {
    const first = daysBetween(firstDay, span.first);
    const last = daysBetween(firstDay, span.last);
    return {
      item,
      first: Math.max(first, 0),
      last: Math.min(last, lastIndex),
      row: 0,
      before: first < 0,
      after: last > lastIndex,
    };
  });
  const rows = packLanes(
    bars,
    (bar) => bar.first,
    (bar) => bar.last + 1,
  );
  for (const bar of bars) bar.row = (rows.get(bar) as Lane).lane;
  return bars;
}

export function layoutTimeGrid<Item extends Shown>(
  days: readonly CivilDate[],
  items: readonly Item[],
  zone: TimeZone,
): TimeGridLayout<Item> {
  const spanned = spannedIn(days, items, zone);
  const bars = barsOf(days, spanned.filter(isBar));
  const columns = days.map((day) => {
    const midnight = wallOfDate(day);
    const minutesOf = (instant: number) =>
      (wallOf(instant, zone) - midnight) / MINUTE_MS;
    const blocks = spanned.flatMap((entry) => {
      if (isBar(entry) || entry.span.first !== day) return [];
      const { time } = entry.item;
      if (time.kind !== "timed") return [];
      return [
        {
          item: entry.item,
          startMinute: minutesOf(time.start),
          endMinute: minutesOf(time.end),
        },
      ];
    });
    const lanes = packLanes(
      blocks,
      (block) => block.startMinute,
      (block) =>
        Math.max(block.endMinute, block.startMinute + SHORTEST_MINUTES),
    );
    return blocks.map((block) => ({ ...block, ...(lanes.get(block) as Lane) }));
  });
  return {
    columns,
    bars,
    barRows: Math.max(0, ...bars.map((bar) => bar.row + 1)),
  };
}

// Bars and timed events share the lines, so a bar keeps one line across all its days.
export function layoutMonthWeek<Item extends Shown>(
  days: readonly CivilDate[],
  items: readonly Item[],
  zone: TimeZone,
): MonthWeekLayout<Item> {
  const spanned = spannedIn(days, items, zone);
  const entries = barsOf(days, spanned).map((bar, index) => ({
    ...bar,
    kind: isBar(spanned[index] as Spanned<Item>)
      ? ("bar" as const)
      : ("timed" as const),
  }));
  const hidden = days.map(() => 0);
  for (const entry of entries) {
    if (entry.row < MONTH_LINES) continue;
    for (let day = entry.first; day <= entry.last; day++) {
      hidden[day] = (hidden[day] as number) + 1;
    }
  }
  return {
    entries: entries.filter((entry) => entry.row < MONTH_LINES),
    hidden,
  };
}
