import {
  type CalendarRole,
  levelOfRole,
  type UserId,
} from "@cloudysuite/access";
import type { SqlDriver, SqlRow, SqlValue } from "@cloudysuite/object-sql";
import {
  type Budget,
  datesOf,
  indexOf,
  repeatOf,
  ruleOf,
  spanOf,
} from "./repeat";
import {
  addDays,
  dateOfOccurrence,
  dateOfWall,
  daysBetween,
  instantOf,
  instantOfOccurrence,
  startDateOf,
  startOfDay,
  type WallTime,
  wallOf,
  wallOfDate,
} from "./time";
import {
  type ChangeResult,
  type EraseResult,
  type ChangeScope,
  type CivilDate,
  type CreateResult,
  type DayRange,
  type EventDetails,
  type EventDraft,
  type EventTarget,
  type EventTime,
  type EventUid,
  MAX_OCCURRENCES,
  type Occurrence,
  type OccurrenceId,
  type Organiser,
  type RangeListing,
  type Repeat,
  type ShownRepeat,
  type TimeZone,
} from "./types";

export type Actor = { userId: UserId; role: CalendarRole };

// About 200 ms of ical.js on the slowest rules, shared by every series in one call.
const STEPS_PER_CALL = 100_000;

type EventRow = SqlRow & {
  uid: string;
  recurrence_id: string | null;
  title: string;
  location: string;
  notes: string;
  starts_at: number | null;
  ends_at: number | null;
  tzid: string | null;
  start_date: string | null;
  end_date: string | null;
  rrule: string | null;
  exdates: string;
  organiser: string;
  sequence: number;
};

type StoredEvent = EventDetails & {
  uid: EventUid;
  recurrenceId: OccurrenceId | null;
  time: EventTime;
  rule: string | null;
  exdates: OccurrenceId[];
  organiser: Organiser;
  sequence: number;
};

function parseRow(row: EventRow): StoredEvent {
  return {
    uid: row.uid as EventUid,
    recurrenceId: row.recurrence_id as OccurrenceId | null,
    title: row.title,
    location: row.location,
    notes: row.notes,
    time:
      row.starts_at === null
        ? {
            kind: "allDay",
            startDate: row.start_date as CivilDate,
            endDate: row.end_date as CivilDate,
          }
        : {
            kind: "timed",
            start: row.starts_at,
            end: row.ends_at as number,
            timeZone: row.tzid as TimeZone,
          },
    rule: row.rrule,
    exdates: JSON.parse(row.exdates) as OccurrenceId[],
    organiser: JSON.parse(row.organiser) as Organiser,
    sequence: row.sequence,
  };
}

const canEdit = (actor: Actor) => levelOfRole(actor.role) === "edit";

const shownRepeat = (series: StoredEvent): ShownRepeat | null =>
  series.rule === null ? null : repeatOf(series.rule, series.time);

// The one rule for changing an event. Removing one needs only Can edit.
const mayChange = (actor: Actor, series: StoredEvent) =>
  canEdit(actor) &&
  series.organiser.kind === "madeHere" &&
  shownRepeat(series)?.frequency !== "custom";

const sameTime = (a: EventTime, b: EventTime) =>
  JSON.stringify(a) === JSON.stringify(b);

// The new half of a series that ends after a number of times takes the dates that are
// left, so splitting it adds none. A person who changed that number chose a new one.
function continuing(
  repeat: Repeat | null,
  before: ShownRepeat | null,
  datesBefore: number,
): Repeat | null {
  if (
    repeat?.end.kind !== "afterTimes" ||
    !before ||
    !("end" in before) ||
    before.end.kind !== "afterTimes" ||
    before.end.times !== repeat.end.times
  ) {
    return repeat;
  }
  return {
    ...repeat,
    end: { kind: "afterTimes", times: repeat.end.times - datesBefore },
  };
}

// One date of a series, before any change to it.
function timeOfDate(series: StoredEvent, id: OccurrenceId): EventTime {
  const { time } = series;
  if (time.kind === "allDay") {
    const startDate = dateOfOccurrence(id);
    return {
      kind: "allDay",
      startDate,
      endDate: addDays(startDate, daysBetween(time.startDate, time.endDate)),
    };
  }
  const start = instantOfOccurrence(id);
  return { ...time, start, end: start + (time.end - time.start) };
}

const wallStart = (time: EventTime) =>
  time.kind === "allDay"
    ? wallOfDate(time.startDate)
    : wallOf(time.start, time.timeZone);

// "All of them", changed from one date: the series' first date moves as far as that date
// did, in local time, so it keeps its place across a daylight-saving change.
function shifted(first: EventTime, from: EventTime, to: EventTime): EventTime {
  const startWall = (wallStart(first) +
    (wallStart(to) - wallStart(from))) as WallTime;
  if (to.kind === "allDay") {
    const startDate = dateOfWall(startWall);
    return {
      kind: "allDay",
      startDate,
      endDate: addDays(startDate, daysBetween(to.startDate, to.endDate)),
    };
  }
  const start = instantOf(startWall, to.timeZone);
  return { ...to, start, end: start + (to.end - to.start) };
}

// Soonest first on the viewer's own clock, with a day's all-day events before its timed
// ones.
export function inViewerOrder(timeZone: TimeZone) {
  const startOf = (time: EventTime) =>
    time.kind === "allDay" ? startOfDay(time.startDate, timeZone) : time.start;
  return (a: Occurrence, b: Occurrence) =>
    startOf(a.time) - startOf(b.time) ||
    Number(b.time.kind === "allDay") - Number(a.time.kind === "allDay") ||
    a.title.localeCompare(b.title);
}

export class EventStore {
  constructor(private readonly db: SqlDriver) {}

  #rows<Row extends SqlRow>(query: string, ...bindings: SqlValue[]) {
    return this.db.exec<Row>(query, ...bindings).toArray();
  }

  #series(uid: EventUid): StoredEvent | null {
    const [row] = this.#rows<EventRow>(
      "SELECT * FROM events WHERE uid = ? AND recurrence_id IS NULL",
      uid,
    );
    return row ? parseRow(row) : null;
  }

  #changeOf(uid: EventUid, id: OccurrenceId): StoredEvent | null {
    const [row] = this.#rows<EventRow>(
      "SELECT * FROM events WHERE uid = ? AND recurrence_id = ?",
      uid,
      id,
    );
    return row ? parseRow(row) : null;
  }

  #write(event: StoredEvent, now: number): void {
    const { time } = event;
    const span = spanOf(time, event.rule);
    const timed = time.kind === "timed";
    this.db.exec(
      `INSERT INTO events (uid, recurrence_id, title, location, notes, starts_at, ends_at,
         tzid, start_date, end_date, rrule, exdates, organiser, sequence, created_at,
         updated_at, span_start, span_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (uid, coalesce(recurrence_id, '')) DO UPDATE SET
         title = excluded.title, location = excluded.location, notes = excluded.notes,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at, tzid = excluded.tzid,
         start_date = excluded.start_date, end_date = excluded.end_date,
         rrule = excluded.rrule, exdates = excluded.exdates,
         organiser = excluded.organiser, sequence = excluded.sequence,
         updated_at = excluded.updated_at, span_start = excluded.span_start,
         span_end = excluded.span_end`,
      event.uid,
      event.recurrenceId,
      event.title,
      event.location,
      event.notes,
      timed ? time.start : null,
      timed ? time.end : null,
      timed ? time.timeZone : null,
      timed ? null : time.startDate,
      timed ? null : time.endDate,
      event.rule,
      JSON.stringify(event.exdates),
      JSON.stringify(event.organiser),
      event.sequence,
      now,
      now,
      span.start,
      span.end,
    );
  }

  // Every changed date from this one on, or all of them.
  #dropChanges(uid: EventUid, from: OccurrenceId | null): void {
    this.db.exec(
      "DELETE FROM events WHERE uid = ? AND recurrence_id >= ?",
      uid,
      from ?? "",
    );
  }

  #endBefore(series: StoredEvent, id: OccurrenceId, now: number): void {
    const repeat = shownRepeat(series) as Repeat;
    const lastDate = addDays(startDateOf(timeOfDate(series, id)), -1);
    this.#dropChanges(series.uid, id);
    this.#write(
      {
        ...series,
        rule: ruleOf(
          { ...repeat, end: { kind: "onDate", date: lastDate } },
          series.time,
        ),
        exdates: series.exdates.filter((exdate) => exdate < id),
        sequence: series.sequence + 1,
      },
      now,
    );
  }

  #placeOf(series: StoredEvent & { rule: string }, id: OccurrenceId) {
    if (series.exdates.includes(id)) return null;
    return indexOf(series.rule, series.time, id, { steps: STEPS_PER_CALL });
  }

  listRange(actor: Actor, range: DayRange): RangeListing {
    const from = startOfDay(range.from, range.timeZone);
    const to = startOfDay(range.to, range.timeZone);
    const overlaps = (time: EventTime) =>
      time.kind === "allDay"
        ? time.startDate < range.to && time.endDate > range.from
        : time.start < to && time.end > from;
    const afterRange = (time: EventTime) =>
      time.kind === "allDay" ? time.startDate >= range.to : time.start >= to;

    const rows = this.#rows<EventRow>(
      `SELECT * FROM events WHERE uid IN (
         SELECT uid FROM events WHERE span_start < ? AND (span_end IS NULL OR span_end > ?)
       )`,
      to,
      from,
    ).map(parseRow);

    const budget: Budget = { steps: STEPS_PER_CALL };
    const found: Occurrence[] = [];
    const show = (
      series: StoredEvent,
      event: StoredEvent,
      occurrenceId: OccurrenceId | null,
      time: EventTime,
    ) =>
      found.push({
        uid: series.uid,
        occurrenceId,
        title: event.title,
        location: event.location,
        notes: event.notes,
        time,
        repeat: shownRepeat(series),
        organiser: series.organiser,
        changeable: mayChange(actor, series),
      });

    for (const series of rows.filter((row) => row.recurrenceId === null)) {
      if (series.rule === null) {
        if (overlaps(series.time)) show(series, series, null, series.time);
        continue;
      }
      const changes = rows.filter(
        (row) => row.uid === series.uid && row.recurrenceId !== null,
      );
      const skipped = new Set([
        ...series.exdates,
        ...changes.map((change) => change.recurrenceId),
      ]);
      let shown = 0;
      for (const date of datesOf(series.rule, series.time, budget)) {
        if (afterRange(date.time) || shown > MAX_OCCURRENCES) break;
        if (!skipped.has(date.id) && overlaps(date.time)) {
          show(series, series, date.id, date.time);
          shown++;
        }
      }
      for (const change of changes) {
        if (overlaps(change.time)) {
          show(series, change, change.recurrenceId, change.time);
        }
      }
    }

    found.sort(inViewerOrder(range.timeZone));
    return {
      occurrences: found.slice(0, MAX_OCCURRENCES),
      complete: found.length <= MAX_OCCURRENCES && budget.steps >= 0,
    };
  }

  create(actor: Actor, draft: EventDraft, now: number): CreateResult {
    if (!canEdit(actor)) return { status: "noAccess" };
    const uid = crypto.randomUUID() as EventUid;
    this.#write(
      {
        uid,
        recurrenceId: null,
        title: draft.title,
        location: draft.location,
        notes: draft.notes,
        time: draft.time,
        rule: draft.repeat && ruleOf(draft.repeat, draft.time),
        exdates: [],
        organiser: { kind: "madeHere", userId: actor.userId },
        sequence: 0,
      },
      now,
    );
    return { status: "created", uid };
  }

  update(
    actor: Actor,
    target: EventTarget,
    scope: ChangeScope,
    draft: EventDraft,
    now: number,
  ): ChangeResult {
    if (!canEdit(actor)) return { status: "noAccess" };
    const series = this.#series(target.uid);
    if (!series) return { status: "gone" };
    if (!mayChange(actor, series)) return { status: "readOnly" };
    const details: EventDetails = {
      title: draft.title,
      location: draft.location,
      notes: draft.notes,
    };
    const id = target.occurrenceId;
    if (series.rule === null || id === null) {
      return this.#replaceSeries(
        series,
        details,
        draft.time,
        draft.repeat,
        now,
      );
    }
    const place = this.#placeOf({ ...series, rule: series.rule }, id);
    if (place === null) return { status: "gone" };
    const change = this.#changeOf(series.uid, id);

    if (scope === "this") {
      this.#write(
        {
          ...series,
          ...details,
          recurrenceId: id,
          time: draft.time,
          rule: null,
          exdates: [],
          sequence: Math.max(series.sequence, change?.sequence ?? 0) + 1,
        },
        now,
      );
      return { status: "done" };
    }

    if (scope === "all" || place === 0) {
      const time =
        draft.repeat === null
          ? draft.time
          : shifted(
              series.time,
              change?.time ?? timeOfDate(series, id),
              draft.time,
            );
      return this.#replaceSeries(series, details, time, draft.repeat, now);
    }

    const repeat = continuing(draft.repeat, shownRepeat(series), place);
    this.db.transaction(() => {
      this.#endBefore(series, id, now);
      this.#write(
        {
          ...details,
          uid: crypto.randomUUID() as EventUid,
          recurrenceId: null,
          time: draft.time,
          rule: repeat && ruleOf(repeat, draft.time),
          exdates: [],
          organiser: series.organiser,
          sequence: 0,
        },
        now,
      );
    });
    return { status: "done" };
  }

  #replaceSeries(
    series: StoredEvent,
    details: EventDetails,
    time: EventTime,
    repeat: Repeat | null,
    now: number,
  ): ChangeResult {
    const rule = repeat && ruleOf(repeat, time);
    const datesMoved = rule !== series.rule || !sameTime(time, series.time);
    this.db.transaction(() => {
      // A changed date names a date the series may no longer have.
      if (datesMoved) this.#dropChanges(series.uid, null);
      this.#write(
        {
          ...series,
          ...details,
          time,
          rule,
          exdates: datesMoved ? [] : series.exdates,
          sequence: series.sequence + 1,
        },
        now,
      );
    });
    return { status: "done" };
  }

  remove(
    actor: Actor,
    target: EventTarget,
    scope: ChangeScope,
    now: number,
  ): ChangeResult {
    if (!canEdit(actor)) return { status: "noAccess" };
    const series = this.#series(target.uid);
    if (!series) return { status: "gone" };
    const id = target.occurrenceId;
    if (series.rule === null || id === null || scope === "all") {
      return this.#removeAll(series.uid, now);
    }
    const place = this.#placeOf({ ...series, rule: series.rule }, id);
    if (place === null) return { status: "gone" };
    if (place === 0 && scope === "thisAndLater") {
      return this.#removeAll(series.uid, now);
    }

    if (scope === "this") {
      const change = this.#changeOf(series.uid, id);
      this.db.transaction(() => {
        this.db.exec(
          "DELETE FROM events WHERE uid = ? AND recurrence_id = ?",
          series.uid,
          id,
        );
        this.#write(
          {
            ...series,
            exdates: [...series.exdates, id].sort(),
            sequence: Math.max(series.sequence, change?.sequence ?? 0) + 1,
          },
          now,
        );
      });
      return { status: "done" };
    }

    // Ending a series rewrites its rule, and a rule from outside is kept as written.
    if (shownRepeat(series)?.frequency === "custom") {
      return { status: "readOnly" };
    }
    this.db.transaction(() => this.#endBefore(series, id, now));
    return { status: "done" };
  }

  // Keeps the highest sequence held for any part of it, so no copy that old counts as new.
  #removeAll(uid: EventUid, now: number): ChangeResult {
    this.db.transaction(() => {
      this.db.exec(
        `INSERT INTO removed_events (uid, sequence, removed_at)
         SELECT uid, max(sequence), ? FROM events WHERE uid = ? GROUP BY uid
         ON CONFLICT (uid) DO UPDATE SET
           sequence = max(sequence, excluded.sequence),
           removed_at = excluded.removed_at`,
        now,
        uid,
      );
      this.db.exec("DELETE FROM events WHERE uid = ?", uid);
    });
    return { status: "done" };
  }

  // A series counts once, however many dates it has or how many of them were changed.
  countEvents(): number {
    const [row] = this.#rows<{ total: number }>(
      "SELECT count(DISTINCT uid) AS total FROM events",
    );
    return row?.total ?? 0;
  }

  // Only a manager, and only once D1 no longer has the calendar.
  erase(actor: Actor): EraseResult {
    if (actor.role !== "manager") return { status: "noAccess" };
    this.db.transaction(() => {
      this.db.exec("DELETE FROM events");
      this.db.exec("DELETE FROM removed_events");
    });
    return { status: "done" };
  }
}
