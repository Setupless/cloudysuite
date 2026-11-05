import type { SqlDriver } from "@cloudysuite/object-sql";
import { type SearchTerm, toPrefixMatch } from "@cloudysuite/search";
import { type Budget, datesOf } from "./repeat";
import {
  type Actor,
  type EventRow,
  occurrenceOf,
  parseRow,
  STEPS_PER_CALL,
  type StoredEvent,
} from "./store";
import { startOfDay } from "./time";
import type {
  EventSearchResult,
  EventTime,
  Occurrence,
  OccurrenceId,
  TimeZone,
} from "./types";

const EVENTS_PER_CALENDAR = 50;

type Found = {
  event: StoredEvent;
  occurrenceId: OccurrenceId | null;
  time: EventTime;
};

// An all-day event covers the reader's own days.
const boundsOf = (time: EventTime, zone: TimeZone) =>
  time.kind === "allDay"
    ? {
        start: startOfDay(time.startDate, zone),
        end: startOfDay(time.endDate, zone),
      }
    : time;

const stillToCome = (time: EventTime, zone: TimeZone, now: number) =>
  boundsOf(time, zone).end > now;

// Events still to come first, soonest first, then past ones, newest first. One that has
// started and not yet ended is still to come.
export function inSearchOrder(zone: TimeZone, now: number) {
  return (a: Occurrence, b: Occurrence) => {
    const first = boundsOf(a.time, zone);
    const second = boundsOf(b.time, zone);
    const firstToCome = first.end > now;
    if (firstToCome !== second.end > now) return firstToCome ? -1 : 1;
    return (
      (firstToCome ? first.start - second.start : second.start - first.start) ||
      a.title.localeCompare(b.title)
    );
  };
}

// The series' first date still to come, or else its last date. A series that outruns the
// budget shows the last date reached.
function seriesDate(
  series: StoredEvent & { rule: string },
  skipped: ReadonlySet<string>,
  zone: TimeZone,
  now: number,
  budget: Budget,
): Found | null {
  let last: Found | null = null;
  for (const date of datesOf(series.rule, series.time, budget)) {
    if (skipped.has(date.id)) continue;
    last = { event: series, occurrenceId: date.id, time: date.time };
    if (stillToCome(date.time, zone, now)) break;
  }
  return last;
}

function shownOf(
  found: readonly Found[],
  zone: TimeZone,
  now: number,
): Found | null {
  const toCome = found.filter((one) => stillToCome(one.time, zone, now));
  const startOf = (one: Found) => boundsOf(one.time, zone).start;
  const [best = null] = toCome.length
    ? toCome.sort((a, b) => startOf(a) - startOf(b))
    : [...found].sort((a, b) => startOf(b) - startOf(a));
  return best;
}

// A changed date of a repeat matches by its own details, and the series' other dates by
// the series'.
export function findEvents(
  db: SqlDriver,
  actor: Actor,
  terms: readonly SearchTerm[],
  zone: TimeZone,
  now: number,
): EventSearchResult {
  const expression = toPrefixMatch(terms);
  if (expression === null) return { occurrences: [], more: false };
  // When more match than one answer holds, the ones that end latest stay, so nothing
  // still to come gives way to something long past.
  const uids = db
    .exec<{ uid: string }>(
      `SELECT uid FROM events
       WHERE rowid IN (SELECT rowid FROM event_search WHERE event_search MATCH ?)
       GROUP BY uid
       ORDER BY max(coalesce(span_end, ?)) DESC, uid
       LIMIT ?`,
      expression,
      Number.MAX_SAFE_INTEGER,
      EVENTS_PER_CALENDAR + 1,
    )
    .toArray()
    .map((row) => row.uid);
  const kept = uids.slice(0, EVENTS_PER_CALENDAR);

  const groups = new Map<string, (EventRow & { matched: number })[]>();
  for (const row of db
    .exec<EventRow & { matched: number }>(
      `SELECT *, rowid IN (
         SELECT rowid FROM event_search WHERE event_search MATCH ?
       ) AS matched
       FROM events WHERE uid IN (SELECT value FROM json_each(?))`,
      expression,
      JSON.stringify(kept),
    )
    .toArray()) {
    groups.set(row.uid, [...(groups.get(row.uid) ?? []), row]);
  }

  const budget: Budget = { steps: STEPS_PER_CALL };
  const occurrences = kept.flatMap((uid) => {
    const rows = groups.get(uid) ?? [];
    const seriesRow = rows.find((row) => row.recurrence_id === null);
    if (!seriesRow) return [];
    const series = parseRow(seriesRow);
    const changes = rows.filter((row) => row.recurrence_id !== null);
    const found: Found[] = changes
      .filter((row) => row.matched)
      .map(parseRow)
      .map((change) => ({
        event: change,
        occurrenceId: change.recurrenceId,
        time: change.time,
      }));
    if (seriesRow.matched && series.rule === null) {
      found.push({ event: series, occurrenceId: null, time: series.time });
    } else if (seriesRow.matched && series.rule !== null) {
      const skipped = new Set([
        ...series.exdates,
        ...changes.map((row) => row.recurrence_id as string),
      ]);
      const date = seriesDate(
        { ...series, rule: series.rule },
        skipped,
        zone,
        now,
        budget,
      );
      if (date) found.push(date);
    }
    const shown = shownOf(found, zone, now);
    return shown
      ? [
          occurrenceOf(
            actor,
            series,
            shown.event,
            shown.occurrenceId,
            shown.time,
          ),
        ]
      : [];
  });

  occurrences.sort(inSearchOrder(zone, now));
  return { occurrences, more: uids.length > EVENTS_PER_CALENDAR };
}
