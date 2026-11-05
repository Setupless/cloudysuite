import {
  type CalendarId,
  type CalendarRole,
  levelOfRole,
  type UserId,
} from "@cloudysuite/access";
import type { SqlDriver, SqlRow, SqlValue } from "@cloudysuite/object-sql";
import type { OutsideEvent } from "./outside/ics";
import {
  type AnswerNotice,
  type DeliveredPart,
  type Delivery,
  type DeliveryResult,
  type QueuedDelivery,
  retryAt,
} from "./invitations";
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
  type Answer,
  type AnswerResult,
  type Attendee,
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
  type ImportSummary,
  type Invitee,
  MAX_OCCURRENCES,
  type Occurrence,
  type OccurrenceId,
  type Organiser,
  type RangeListing,
  type Repeat,
  type ShownRepeat,
  type Shortfall,
  SKIP_REASONS,
  type SkipReason,
  type TimeZone,
} from "./types";

export type Actor = {
  userId: UserId;
  role: CalendarRole;
  // The calendar being asked, which its own object can't read from its name.
  calendarId: CalendarId;
};

// What the store keeps of one event in a file.
export type ImportedPart = EventDetails & {
  recurrenceId: OccurrenceId | null;
  time: EventTime;
  rule: string | null;
  exdates: OccurrenceId[];
  sequence: number;
  shortfall: Shortfall | null;
  cancelled: boolean;
};

// One event: its series, or null when the file only changes dates of a series held
// here, and its changed dates.
export type ImportGroup = {
  uid: EventUid;
  series: ImportedPart | null;
  changes: ImportedPart[];
};

export type ImportResult =
  { status: "done"; summary: ImportSummary } | { status: "noAccess" };

type ImportOutcome =
  "added" | "updated" | "unchanged" | "organisedElsewhere" | SkipReason;

const partOf = (event: OutsideEvent): ImportedPart => ({
  title: event.title,
  location: event.location,
  notes: event.notes,
  recurrenceId: event.recurrenceId,
  time: event.time,
  rule: event.rule,
  exdates: event.exdates,
  sequence: event.sequence,
  shortfall: event.shortfall,
  cancelled: event.cancelled,
});

// A file can hold the same event or date twice. The higher sequence wins, then the first.
export function groupForImport(events: OutsideEvent[]): ImportGroup[] {
  const groups = new Map<EventUid, ImportGroup>();
  const newer = (held: ImportedPart | null | undefined, part: ImportedPart) =>
    !held || part.sequence > held.sequence;
  for (const event of events) {
    const group = groups.get(event.uid) ?? {
      uid: event.uid,
      series: null,
      changes: [],
    };
    groups.set(event.uid, group);
    const part = partOf(event);
    if (part.recurrenceId === null) {
      if (newer(group.series, part)) group.series = part;
      continue;
    }
    const index = group.changes.findIndex(
      (change) => change.recurrenceId === part.recurrenceId,
    );
    if (index === -1) group.changes.push(part);
    else if (newer(group.changes[index], part)) group.changes[index] = part;
  }
  return [...groups.values()];
}

export const emptySummary = (): ImportSummary => ({
  added: 0,
  updated: 0,
  unchanged: 0,
  organisedElsewhere: 0,
  firstDateOnly: 0,
  mainRepeatOnly: 0,
  skipped: {},
});

export function countSkip(
  summary: ImportSummary,
  reason: SkipReason,
  count: number,
): void {
  summary.skipped[reason] = (summary.skipped[reason] ?? 0) + count;
}

export function addSummary(total: ImportSummary, part: ImportSummary): void {
  total.added += part.added;
  total.updated += part.updated;
  total.unchanged += part.unchanged;
  total.organisedElsewhere += part.organisedElsewhere;
  total.firstDateOnly += part.firstDateOnly;
  total.mainRepeatOnly += part.mainRepeatOnly;
  for (const reason of SKIP_REASONS) {
    const count = part.skipped[reason];
    if (count) countSkip(total, reason, count);
  }
}

// About 200 ms of ical.js on the slowest rules, shared by every series in one call.
export const STEPS_PER_CALL = 100_000;

export type EventRow = SqlRow & {
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
  cancelled: number;
};

export type StoredEvent = EventDetails & {
  uid: EventUid;
  recurrenceId: OccurrenceId | null;
  time: EventTime;
  rule: string | null;
  exdates: OccurrenceId[];
  organiser: Organiser;
  sequence: number;
  cancelled: boolean;
};

export function parseRow(row: EventRow): StoredEvent {
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
    cancelled: row.cancelled === 1,
  };
}

// The revision is the latest answer heard from that person, so a late older one changes
// nothing.
type StoredAttendee = Attendee & { revision: number };

// On a copy, whose answer this calendar holds and what it is.
type Reply = { for: UserId; answer: Answer; revision: number };

// Everyone invited to one event. Every date of a repeat has the same people.
export type People = {
  attendees: StoredAttendee[];
  revision: number;
  // Null in the organiser's calendar.
  reply: Reply | null;
};

type PeopleRow = SqlRow & {
  uid: string;
  attendees: string;
  revision: number;
  reply: string | null;
};

// Dates removed from a copy here, which no later change from its organiser brings back.
export type Removal = { dates: ReadonlySet<string>; from: string | null };

export const isRemovedHere = (removal: Removal | undefined, id: OccurrenceId) =>
  removal !== undefined &&
  (removal.dates.has(id) || (removal.from !== null && id >= removal.from));

const inUids = "uid IN (SELECT value FROM json_each(?))";

export function readPeople(
  db: SqlDriver,
  uids: readonly string[],
): Map<string, People> {
  return new Map(
    db
      .exec<PeopleRow>(
        `SELECT * FROM event_people WHERE ${inUids}`,
        JSON.stringify(uids),
      )
      .toArray()
      .map((row) => [
        row.uid,
        {
          attendees: JSON.parse(row.attendees) as StoredAttendee[],
          revision: row.revision,
          reply: row.reply === null ? null : (JSON.parse(row.reply) as Reply),
        },
      ]),
  );
}

export function readRemovals(
  db: SqlDriver,
  uids: readonly string[],
): Map<string, Removal> {
  const removals = new Map<
    string,
    { dates: Set<string>; from: string | null }
  >();
  for (const row of db
    .exec<{ uid: string; recurrence_id: string; and_later: number }>(
      `SELECT uid, recurrence_id, and_later FROM removed_dates WHERE ${inUids}`,
      JSON.stringify(uids),
    )
    .toArray()) {
    const removal = removals.get(row.uid) ?? { dates: new Set(), from: null };
    removals.set(row.uid, removal);
    if (!row.and_later) removal.dates.add(row.recurrence_id);
    else if (removal.from === null || row.recurrence_id < removal.from) {
      removal.from = row.recurrence_id;
    }
  }
  return removals;
}

const shownPeople = (people: People | undefined): Attendee[] =>
  (people?.attendees ?? []).map(
    ({ revision: _revision, ...attendee }) => attendee,
  );

const canEdit = (actor: Actor) => levelOfRole(actor.role) === "edit";

// A copy of an event organised elsewhere, which follows its organiser.
const isCopy = (series: StoredEvent) => series.organiser.kind !== "madeHere";

const shownRepeat = (series: StoredEvent): ShownRepeat | null =>
  series.rule === null ? null : repeatOf(series.rule, series.time);

// The one rule for changing an event. Removing one needs only Can edit.
const mayChange = (actor: Actor, series: StoredEvent) =>
  canEdit(actor) &&
  series.organiser.kind === "madeHere" &&
  shownRepeat(series)?.frequency !== "custom";

// One date as the person sees it. A changed date has its own details, and the series
// decides the repeat, the organiser, the people, and whether it can be changed.
export const occurrenceOf = (
  actor: Actor,
  series: StoredEvent,
  event: StoredEvent,
  occurrenceId: OccurrenceId | null,
  time: EventTime,
  people: People | undefined,
): Occurrence => ({
  uid: series.uid,
  occurrenceId,
  title: event.title,
  location: event.location,
  notes: event.notes,
  time,
  repeat: shownRepeat(series),
  organiser: series.organiser,
  changeable: mayChange(actor, series),
  people: shownPeople(people),
  answer:
    people?.reply && people.reply.for === actor.userId
      ? people.reply.answer
      : null,
  cancelled: series.cancelled || event.cancelled,
});

const sameTime = (a: EventTime, b: EventTime) =>
  JSON.stringify(a) === JSON.stringify(b);

const idsOf = (attendees: readonly StoredAttendee[]) =>
  attendees.map((attendee) => attendee.userId);

const samePeople = (
  a: readonly StoredAttendee[],
  b: readonly StoredAttendee[],
) =>
  a.length === b.length &&
  b.every((attendee) => a.some((held) => held.userId === attendee.userId));

// Who the dialog asked for, in its order. Someone already invited keeps their answer,
// even if they've since been suspended. Anyone new must be someone the directory offers.
// The organiser is never one of their own guests.
function plannedPeople(
  requested: readonly UserId[],
  held: readonly StoredAttendee[],
  invitable: readonly Invitee[],
  organiser: UserId,
): StoredAttendee[] | null {
  const planned: StoredAttendee[] = [];
  for (const userId of new Set(requested)) {
    if (userId === organiser) continue;
    const kept = held.find((attendee) => attendee.userId === userId);
    const found = invitable.find((invitee) => invitee.userId === userId);
    if (kept) planned.push(kept);
    else if (found) {
      planned.push({
        kind: "colleague",
        userId,
        name: found.name,
        answer: "needsAnswer",
        revision: 0,
      });
    } else return null;
  }
  // Nothing changed, so the order they were first invited in stays.
  return samePeople(held, planned) ? [...held] : planned;
}

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

const deliveredPartOf = (event: StoredEvent): DeliveredPart => ({
  recurrenceId: event.recurrenceId,
  title: event.title,
  location: event.location,
  notes: event.notes,
  time: event.time,
  rule: event.rule,
  exdates: event.exdates,
  sequence: event.sequence,
});

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

  #people(uid: EventUid): People | undefined {
    return readPeople(this.db, [uid]).get(uid);
  }

  #write(event: StoredEvent, now: number): void {
    const { time } = event;
    const span = spanOf(time, event.rule);
    const timed = time.kind === "timed";
    this.db.exec(
      `INSERT INTO events (uid, recurrence_id, title, location, notes, starts_at, ends_at,
         tzid, start_date, end_date, rrule, exdates, organiser, sequence, created_at,
         updated_at, span_start, span_end, cancelled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (uid, coalesce(recurrence_id, '')) DO UPDATE SET
         title = excluded.title, location = excluded.location, notes = excluded.notes,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at, tzid = excluded.tzid,
         start_date = excluded.start_date, end_date = excluded.end_date,
         rrule = excluded.rrule, exdates = excluded.exdates,
         organiser = excluded.organiser, sequence = excluded.sequence,
         updated_at = excluded.updated_at, span_start = excluded.span_start,
         span_end = excluded.span_end, cancelled = excluded.cancelled`,
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
      event.cancelled ? 1 : 0,
    );
  }

  #writePeople(uid: EventUid, people: People | null): void {
    if (people === null || people.attendees.length === 0) {
      this.db.exec("DELETE FROM event_people WHERE uid = ?", uid);
      return;
    }
    this.db.exec(
      `INSERT INTO event_people (uid, attendees, revision, reply) VALUES (?, ?, ?, ?)
       ON CONFLICT (uid) DO UPDATE SET attendees = excluded.attendees,
         revision = excluded.revision, reply = excluded.reply`,
      uid,
      JSON.stringify(people.attendees),
      people.revision,
      people.reply && JSON.stringify(people.reply),
    );
  }

  // In the transaction that changes the event. Each person's copy is sent the event as it
  // is when the delivery goes, so a later change needs no second row, only a new version.
  #queue(
    uid: EventUid,
    people: readonly UserId[],
    calendarId: CalendarId,
    now: number,
  ): void {
    for (const userId of new Set(people)) {
      this.db.exec(
        `INSERT INTO deliveries (user_id, uid, calendar_id, version, tries, try_at)
         VALUES (?, ?, ?, 1, 0, ?)
         ON CONFLICT (user_id, uid) DO UPDATE SET version = version + 1, tries = 0,
           try_at = excluded.try_at`,
        userId,
        uid,
        calendarId,
        now,
      );
    }
  }

  // Everyone invited before or after a change, so someone taken off hears it's off.
  #queueFor(
    uid: EventUid,
    before: readonly StoredAttendee[],
    after: readonly StoredAttendee[],
    actor: Actor,
    now: number,
  ): void {
    this.#queue(
      uid,
      [...idsOf(before), ...idsOf(after)],
      actor.calendarId,
      now,
    );
  }

  // Every change here takes this, read before it drops a changed date, so no copy holds a
  // sequence for any part of the event as high as the change's.
  #nextSequence(uid: EventUid): number {
    const [row] = this.#rows<{ top: number | null }>(
      "SELECT max(sequence) AS top FROM events WHERE uid = ?",
      uid,
    );
    return (row?.top ?? -1) + 1;
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
    const sequence = this.#nextSequence(series.uid);
    this.#dropChanges(series.uid, id);
    this.#write(
      {
        ...series,
        rule: ruleOf(
          { ...repeat, end: { kind: "onDate", date: lastDate } },
          series.time,
        ),
        exdates: series.exdates.filter((exdate) => exdate < id),
        sequence,
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
    const uids = [...new Set(rows.map((row) => row.uid))];
    const people = readPeople(this.db, uids);
    const removals = readRemovals(this.db, uids);

    const budget: Budget = { steps: STEPS_PER_CALL };
    const found: Occurrence[] = [];
    const show = (
      series: StoredEvent,
      event: StoredEvent,
      occurrenceId: OccurrenceId | null,
      time: EventTime,
    ) =>
      found.push(
        occurrenceOf(
          actor,
          series,
          event,
          occurrenceId,
          time,
          people.get(series.uid),
        ),
      );

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
      const removal = removals.get(series.uid);
      let shown = 0;
      for (const date of datesOf(series.rule, series.time, budget)) {
        if (afterRange(date.time) || shown > MAX_OCCURRENCES) break;
        if (
          !skipped.has(date.id) &&
          !isRemovedHere(removal, date.id) &&
          overlaps(date.time)
        ) {
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

  create(
    actor: Actor,
    organiserName: string,
    draft: EventDraft,
    invitable: readonly Invitee[],
    now: number,
  ): CreateResult {
    if (!canEdit(actor)) return { status: "noAccess" };
    const attendees = plannedPeople(draft.people, [], invitable, actor.userId);
    if (!attendees) return { status: "notInvitable" };
    const uid = crypto.randomUUID() as EventUid;
    this.db.transaction(() => {
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
          organiser: {
            kind: "madeHere",
            userId: actor.userId,
            name: organiserName,
          },
          sequence: 0,
          cancelled: false,
        },
        now,
      );
      this.#writePeople(uid, { attendees, revision: 1, reply: null });
      this.#queueFor(uid, [], attendees, actor, now);
    });
    return { status: "created", uid };
  }

  update(
    actor: Actor,
    target: EventTarget,
    scope: ChangeScope,
    draft: EventDraft,
    invitable: readonly Invitee[],
    now: number,
  ): ChangeResult {
    if (!canEdit(actor)) return { status: "noAccess" };
    const series = this.#series(target.uid);
    if (!series) return { status: "gone" };
    if (!mayChange(actor, series) || series.organiser.kind !== "madeHere") {
      return { status: "readOnly" };
    }
    const held = this.#people(series.uid);
    const before = held?.attendees ?? [];
    const after = plannedPeople(
      draft.people,
      before,
      invitable,
      series.organiser.userId,
    );
    if (!after) return { status: "notInvitable" };
    const details: EventDetails = {
      title: draft.title,
      location: draft.location,
      notes: draft.notes,
    };
    const id = target.occurrenceId;
    if (series.rule === null || id === null) {
      return this.#replaceSeries(
        actor,
        series,
        details,
        draft.time,
        draft.repeat,
        after,
        now,
      );
    }
    const place = this.#placeOf({ ...series, rule: series.rule }, id);
    if (place === null) return { status: "gone" };
    const change = this.#changeOf(series.uid, id);

    if (scope === "this") {
      if (!samePeople(before, after)) return { status: "peopleForOneDate" };
      this.db.transaction(() => {
        this.#write(
          {
            ...series,
            ...details,
            recurrenceId: id,
            time: draft.time,
            rule: null,
            exdates: [],
            sequence: this.#nextSequence(series.uid),
          },
          now,
        );
        this.#queueFor(series.uid, before, before, actor, now);
      });
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
      return this.#replaceSeries(
        actor,
        series,
        details,
        time,
        draft.repeat,
        after,
        now,
      );
    }

    const repeat = continuing(draft.repeat, shownRepeat(series), place);
    const uid = crypto.randomUUID() as EventUid;
    // The new series is a new invitation, so its copies count answers from the start.
    // Each person keeps what they last said, so nobody who said Yes is asked again.
    const carried = after.map((attendee) => ({ ...attendee, revision: 0 }));
    this.db.transaction(() => {
      this.#endBefore(series, id, now);
      this.#queueFor(series.uid, before, before, actor, now);
      this.#write(
        {
          ...details,
          uid,
          recurrenceId: null,
          time: draft.time,
          rule: repeat && ruleOf(repeat, draft.time),
          exdates: [],
          organiser: series.organiser,
          sequence: 0,
          cancelled: false,
        },
        now,
      );
      this.#writePeople(uid, { attendees: carried, revision: 1, reply: null });
      this.#queueFor(uid, [], carried, actor, now);
    });
    return { status: "done" };
  }

  #replaceSeries(
    actor: Actor,
    series: StoredEvent,
    details: EventDetails,
    time: EventTime,
    repeat: Repeat | null,
    after: StoredAttendee[],
    now: number,
  ): ChangeResult {
    const rule = repeat && ruleOf(repeat, time);
    const datesMoved = rule !== series.rule || !sameTime(time, series.time);
    const held = this.#people(series.uid);
    const before = held?.attendees ?? [];
    this.db.transaction(() => {
      const sequence = this.#nextSequence(series.uid);
      // A changed date names a date the series may no longer have.
      if (datesMoved) this.#dropChanges(series.uid, null);
      this.#write(
        {
          ...series,
          ...details,
          time,
          rule,
          exdates: datesMoved ? [] : series.exdates,
          sequence,
        },
        now,
      );
      if (!samePeople(before, after)) {
        this.#writePeople(series.uid, {
          attendees: after,
          revision: (held?.revision ?? 0) + 1,
          reply: null,
        });
      }
      this.#queueFor(series.uid, before, after, actor, now);
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
      return this.#removeAll(actor, series.uid, now);
    }
    if (isCopy(series)) {
      return this.#removeFromCopy(
        actor,
        { ...series, rule: series.rule },
        id,
        scope,
        now,
      );
    }
    const place = this.#placeOf({ ...series, rule: series.rule }, id);
    if (place === null) return { status: "gone" };
    if (place === 0 && scope === "thisAndLater") {
      return this.#removeAll(actor, series.uid, now);
    }
    const people = this.#people(series.uid)?.attendees ?? [];

    if (scope === "this") {
      this.db.transaction(() => {
        const sequence = this.#nextSequence(series.uid);
        this.db.exec(
          "DELETE FROM events WHERE uid = ? AND recurrence_id = ?",
          series.uid,
          id,
        );
        this.#write(
          {
            ...series,
            exdates: [...series.exdates, id].sort(),
            sequence,
          },
          now,
        );
        this.#queueFor(series.uid, people, people, actor, now);
      });
      return { status: "done" };
    }

    // Ending a series rewrites its rule, and a rule from outside is kept as written.
    if (shownRepeat(series)?.frequency === "custom") {
      return { status: "readOnly" };
    }
    this.db.transaction(() => {
      this.#endBefore(series, id, now);
      this.#queueFor(series.uid, people, people, actor, now);
    });
    return { status: "done" };
  }

  // The organiser's rule and dates stay as they sent them, so their next change still
  // lands, and the dates removed here stay out of it.
  #removeFromCopy(
    actor: Actor,
    series: StoredEvent & { rule: string },
    id: OccurrenceId,
    scope: Exclude<ChangeScope, "all">,
    now: number,
  ): ChangeResult {
    const place = indexOf(series.rule, series.time, id, {
      steps: STEPS_PER_CALL,
    });
    if (place === null) return { status: "gone" };
    if (place === 0 && scope === "thisAndLater") {
      return this.#removeAll(actor, series.uid, now);
    }
    const andLater = scope === "thisAndLater";
    this.db.transaction(() => {
      this.db.exec(
        `INSERT INTO removed_dates (uid, recurrence_id, and_later, removed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (uid, recurrence_id) DO UPDATE SET
           and_later = max(and_later, excluded.and_later)`,
        series.uid,
        id,
        andLater ? 1 : 0,
        now,
      );
      if (andLater) this.#dropChanges(series.uid, id);
      else {
        this.db.exec(
          "DELETE FROM events WHERE uid = ? AND recurrence_id = ?",
          series.uid,
          id,
        );
      }
    });
    return { status: "done" };
  }

  // Keeps the highest sequence held for any part of it, so no copy that old counts as new.
  // Everyone invited hears the event is off.
  #removeAll(actor: Actor, uid: EventUid, now: number): ChangeResult {
    const people = this.#people(uid);
    this.db.transaction(() => {
      if (people && !people.reply) {
        this.#queueFor(uid, people.attendees, [], actor, now);
      }
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
      this.db.exec("DELETE FROM event_people WHERE uid = ?", uid);
      this.db.exec("DELETE FROM removed_dates WHERE uid = ?", uid);
    });
    return { status: "done" };
  }

  // Only the person the copy was sent to answers it, even once their calendar has been
  // handed to someone else. The answer stays here, and a notice takes it to the organiser.
  answer(
    actor: Actor,
    uid: EventUid,
    answer: Answer,
    now: number,
  ): AnswerResult {
    const series = this.#series(uid);
    const held = this.#people(uid);
    const reply = held?.reply;
    if (
      !series ||
      !held ||
      !reply ||
      reply.for !== actor.userId ||
      series.organiser.kind !== "colleague"
    ) {
      return { status: "gone" };
    }
    if (reply.answer === answer) return { status: "done" };
    const given = { ...reply, answer, revision: reply.revision + 1 };
    const calendarId = series.organiser.calendarId;
    this.db.transaction(() => {
      this.#writePeople(uid, {
        ...held,
        attendees: held.attendees.map((attendee) =>
          attendee.userId === actor.userId ? { ...attendee, answer } : attendee,
        ),
        reply: given,
      });
      this.db.exec(
        `INSERT INTO answer_notices (uid, calendar_id, attendee, answer, revision, tries, try_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (uid) DO UPDATE SET calendar_id = excluded.calendar_id,
           attendee = excluded.attendee, answer = excluded.answer,
           revision = excluded.revision, tries = 0, try_at = excluded.try_at`,
        uid,
        calendarId,
        actor.userId,
        answer,
        given.revision,
        now,
      );
    });
    return { status: "done" };
  }

  // A copy is written only over an earlier copy from the same calendar. A part whose
  // sequence is no higher than the one held changes nothing, and a removed event or date
  // stays removed.
  receiveInvitation(delivery: Delivery, now: number): DeliveryResult {
    const { uid } = delivery;
    if (this.#rows("SELECT 1 FROM removed_events WHERE uid = ?", uid).length) {
      return "unchanged";
    }
    const held = this.#series(uid);
    if (
      held &&
      !(
        held.organiser.kind === "colleague" &&
        held.organiser.calendarId === delivery.from
      )
    ) {
      return "refused";
    }
    if (delivery.kind === "cancelled") {
      // Against the series, whose sequence only grows. A newer file can drop a changed
      // date whose sequence was higher than any the organiser holds now.
      if (!held || held.sequence > delivery.sequence) return "unchanged";
      const [row] = this.#rows<{ settled: number }>(
        "SELECT min(cancelled) AS settled FROM events WHERE uid = ?",
        uid,
      );
      if (row?.settled === 1) return "unchanged";
      this.db.exec("UPDATE events SET cancelled = 1 WHERE uid = ?", uid);
      return "received";
    }

    const seriesPart = delivery.parts.find(
      (part) => part.recurrenceId === null,
    );
    if (!seriesPart) return "refused";
    const organiser: Organiser = {
      kind: "colleague",
      userId: delivery.organiser.userId,
      name: delivery.organiser.name,
      calendarId: delivery.from,
    };
    const copyOf = (part: DeliveredPart): StoredEvent => ({
      ...part,
      uid,
      organiser,
      cancelled: false,
    });
    const removal = readRemovals(this.db, [uid]).get(uid);
    let changed = false;
    this.db.transaction(() => {
      if (!held || seriesPart.sequence > held.sequence) {
        changed = true;
        this.#replaceCopySeries(
          held,
          copyOf(seriesPart),
          delivery,
          removal,
          now,
        );
      }
      for (const part of delivery.parts) {
        const id = part.recurrenceId;
        if (id === null || isRemovedHere(removal, id)) continue;
        const heldChange = this.#changeOf(uid, id);
        if (heldChange && heldChange.sequence >= part.sequence) continue;
        changed = true;
        this.#write(copyOf(part), now);
      }
      const heldPeople = this.#people(uid);
      if (!heldPeople || delivery.peopleRevision > heldPeople.revision) {
        changed = true;
        const reply = heldPeople?.reply ?? {
          for: delivery.to,
          answer:
            delivery.people.find((person) => person.userId === delivery.to)
              ?.answer ?? "needsAnswer",
          revision: 0,
        };
        this.#writePeople(uid, {
          attendees: delivery.people.map((person) => ({
            ...person,
            answer: person.userId === reply.for ? reply.answer : person.answer,
            revision: 0,
          })),
          revision: delivery.peopleRevision,
          reply,
        });
      }
    });
    return changed ? "received" : "unchanged";
  }

  // A date the organiser has newly removed stays on the copy, marked as called off, so
  // someone who looks sees it was cancelled rather than finding it gone. A changed date
  // the organiser no longer has goes.
  #replaceCopySeries(
    held: StoredEvent | null,
    series: StoredEvent,
    delivery: Extract<Delivery, { kind: "event" }>,
    removal: Removal | undefined,
    now: number,
  ): void {
    const heldChanges = held
      ? this.#rows<EventRow>(
          "SELECT * FROM events WHERE uid = ? AND recurrence_id IS NOT NULL",
          series.uid,
        ).map(parseRow)
      : [];
    const calledOff = held
      ? series.exdates.flatMap((id): StoredEvent[] => {
          if (held.exdates.includes(id) || isRemovedHere(removal, id)) {
            return [];
          }
          const before = heldChanges.find(
            (change) => change.recurrenceId === id,
          );
          return [
            {
              ...(before ?? held),
              recurrenceId: id,
              time: before?.time ?? timeOfDate(held, id),
              rule: null,
              exdates: [],
              organiser: series.organiser,
              sequence: series.sequence,
              cancelled: true,
            },
          ];
        })
      : [];
    const delivered = new Set(delivery.parts.map((part) => part.recurrenceId));
    for (const change of heldChanges) {
      const id = change.recurrenceId as OccurrenceId;
      const stillOff = change.cancelled && series.exdates.includes(id);
      if (!delivered.has(id) && !stillOff) {
        this.db.exec(
          "DELETE FROM events WHERE uid = ? AND recurrence_id = ?",
          series.uid,
          id,
        );
      }
    }
    this.#write(series, now);
    for (const change of calledOff) this.#write(change, now);
  }

  // Only the organiser's calendar takes answers, and only a newer one from someone it
  // invited. Everyone else invited is sent the new list.
  receiveAnswer(notice: AnswerNotice, now: number): void {
    const held = this.#people(notice.uid);
    if (!held || held.reply || !this.#series(notice.uid)) return;
    const attendee = held.attendees.find(
      (person) => person.userId === notice.attendee,
    );
    if (!attendee || notice.revision <= attendee.revision) return;
    const attendees = held.attendees.map((person) =>
      person === attendee
        ? { ...person, answer: notice.answer, revision: notice.revision }
        : person,
    );
    this.db.transaction(() => {
      this.#writePeople(notice.uid, {
        attendees,
        revision: held.revision + 1,
        reply: null,
      });
      this.#queue(
        notice.uid,
        idsOf(attendees).filter((userId) => userId !== notice.attendee),
        notice.calendarId,
        now,
      );
    });
  }

  dueDeliveries(now: number, limit: number): QueuedDelivery[] {
    return this.#rows<{
      user_id: string;
      uid: string;
      calendar_id: string;
      version: number;
    }>(
      `SELECT user_id, uid, calendar_id, version FROM deliveries
       WHERE try_at <= ? ORDER BY try_at LIMIT ?`,
      now,
      limit,
    ).map((row) => ({
      userId: row.user_id as UserId,
      uid: row.uid as EventUid,
      calendarId: row.calendar_id as CalendarId,
      version: row.version,
    }));
  }

  // The event as it is now. Someone no longer invited is told it's off at the series'
  // sequence, which putting them back raises. An event that's gone is told at the highest
  // sequence it had.
  deliveryFor(queued: QueuedDelivery): Delivery {
    const { uid, userId, calendarId } = queued;
    const rows = this.#rows<EventRow>(
      "SELECT * FROM events WHERE uid = ? ORDER BY recurrence_id IS NOT NULL, recurrence_id",
      uid,
    ).map(parseRow);
    const series = rows.find((row) => row.recurrenceId === null);
    const people = this.#people(uid);
    if (
      !series ||
      series.organiser.kind !== "madeHere" ||
      !people ||
      people.reply ||
      !people.attendees.some((attendee) => attendee.userId === userId)
    ) {
      const [removed] = this.#rows<{ sequence: number }>(
        "SELECT sequence FROM removed_events WHERE uid = ?",
        uid,
      );
      return {
        kind: "cancelled",
        uid,
        from: calendarId,
        sequence: series?.sequence ?? removed?.sequence ?? 0,
      };
    }
    return {
      kind: "event",
      uid,
      from: calendarId,
      to: userId,
      organiser: {
        userId: series.organiser.userId,
        name: series.organiser.name,
      },
      parts: rows.map(deliveredPartOf),
      people: shownPeople(people),
      peopleRevision: people.revision,
    };
  }

  // Only the version that went, so a change made while it was on its way still goes.
  finishDelivery(queued: QueuedDelivery): void {
    this.db.exec(
      "DELETE FROM deliveries WHERE user_id = ? AND uid = ? AND version = ?",
      queued.userId,
      queued.uid,
      queued.version,
    );
  }

  postponeDelivery(queued: QueuedDelivery, now: number): void {
    const [row] = this.#rows<{ tries: number }>(
      "SELECT tries FROM deliveries WHERE user_id = ? AND uid = ? AND version = ?",
      queued.userId,
      queued.uid,
      queued.version,
    );
    if (!row) return;
    this.db.exec(
      `UPDATE deliveries SET tries = tries + 1, try_at = ?
       WHERE user_id = ? AND uid = ? AND version = ?`,
      retryAt(now, row.tries),
      queued.userId,
      queued.uid,
      queued.version,
    );
  }

  dueAnswers(now: number, limit: number): AnswerNotice[] {
    return this.#rows<{
      uid: string;
      calendar_id: string;
      attendee: string;
      answer: string;
      revision: number;
    }>(
      `SELECT uid, calendar_id, attendee, answer, revision FROM answer_notices
       WHERE try_at <= ? ORDER BY try_at LIMIT ?`,
      now,
      limit,
    ).map((row) => ({
      uid: row.uid as EventUid,
      calendarId: row.calendar_id as CalendarId,
      attendee: row.attendee as UserId,
      answer: row.answer as Answer,
      revision: row.revision,
    }));
  }

  finishAnswer(notice: AnswerNotice): void {
    this.db.exec(
      "DELETE FROM answer_notices WHERE uid = ? AND revision = ?",
      notice.uid,
      notice.revision,
    );
  }

  postponeAnswer(notice: AnswerNotice, now: number): void {
    const [row] = this.#rows<{ tries: number }>(
      "SELECT tries FROM answer_notices WHERE uid = ? AND revision = ?",
      notice.uid,
      notice.revision,
    );
    if (!row) return;
    this.db.exec(
      "UPDATE answer_notices SET tries = tries + 1, try_at = ? WHERE uid = ? AND revision = ?",
      retryAt(now, row.tries),
      notice.uid,
      notice.revision,
    );
  }

  nextWakeUpAt(): number | null {
    const [row] = this.#rows<{ next: number | null }>(
      `SELECT min(next) AS next FROM (
         SELECT min(try_at) AS next FROM deliveries
         UNION ALL SELECT min(try_at) FROM answer_notices
       )`,
    );
    return row?.next ?? null;
  }

  // Each event goes in under the rule for invitations: a copy no newer than the one held
  // for that event or date changes nothing, so the same file twice changes nothing, and
  // a retry after a crash finishes the work without doing any of it twice. Everyone
  // invited to an event the file changes is sent the change.
  importEvents(
    actor: Actor,
    organiserName: string,
    groups: ImportGroup[],
    now: number,
  ): ImportResult {
    if (!canEdit(actor)) return { status: "noAccess" };
    const importer: Organiser = {
      kind: "madeHere",
      userId: actor.userId,
      name: organiserName,
    };
    const summary = emptySummary();
    for (const group of groups) {
      const outcome = this.db.transaction(() => {
        const outcome = this.#importGroup(importer, group, now);
        const people = this.#people(group.uid);
        if (outcome === "updated" && people && !people.reply) {
          this.#queueFor(group.uid, people.attendees, [], actor, now);
        }
        return outcome;
      });
      if (outcome === "added" || outcome === "updated") {
        summary[outcome]++;
        const shortfall = group.series?.shortfall;
        if (shortfall) summary[shortfall]++;
      } else if (outcome === "unchanged" || outcome === "organisedElsewhere") {
        summary[outcome]++;
      } else {
        countSkip(summary, outcome, 1);
      }
    }
    return { status: "done", summary };
  }

  #importGroup(
    importer: Organiser,
    group: ImportGroup,
    now: number,
  ): ImportOutcome {
    const { uid, series } = group;
    // Removing an event is the person's choice, and import can't change what they
    // couldn't change by hand, such as an invitation organised somewhere else.
    const [removed] = this.#rows(
      "SELECT uid FROM removed_events WHERE uid = ?",
      uid,
    );
    const held = this.#series(uid);
    if (removed) return "unchanged";
    if (held && isCopy(held)) return "organisedElsewhere";
    if (series?.cancelled) return held ? "unchanged" : "cancelled";

    if (series && (!held || series.sequence > held.sequence)) {
      const cancelled = group.changes.flatMap((change) =>
        change.cancelled ? [change.recurrenceId as OccurrenceId] : [],
      );
      const written: StoredEvent = {
        uid,
        recurrenceId: null,
        title: series.title,
        location: series.location,
        notes: series.notes,
        time: series.time,
        rule: series.rule,
        // A date removed here stays removed.
        exdates: [
          ...new Set([
            ...(held?.exdates ?? []),
            ...series.exdates,
            ...cancelled,
          ]),
        ].sort(),
        organiser: held?.organiser ?? importer,
        sequence: series.sequence,
        cancelled: false,
      };
      if (held) this.#dropChanges(uid, null);
      this.#write(written, now);
      for (const change of group.changes) {
        if (!change.cancelled) this.#writeChange(written, change, now);
      }
      return held ? "updated" : "added";
    }

    if (!held) return "noSeries";
    let changed = false;
    for (const change of group.changes) {
      const id = change.recurrenceId as OccurrenceId;
      const before = this.#series(uid) as StoredEvent;
      const heldChange = this.#changeOf(uid, id);
      if (
        before.exdates.includes(id) ||
        change.sequence <= Math.max(before.sequence, heldChange?.sequence ?? 0)
      ) {
        continue;
      }
      changed = true;
      if (!change.cancelled) {
        this.#writeChange(before, change, now);
        continue;
      }
      this.db.exec(
        "DELETE FROM events WHERE uid = ? AND recurrence_id = ?",
        uid,
        id,
      );
      // The series takes the sequence that called the date off, so a copy of it sees a
      // newer series and calls the date off too.
      this.#write(
        {
          ...before,
          exdates: [...before.exdates, id].sort(),
          sequence: change.sequence,
        },
        now,
      );
    }
    return changed ? "updated" : "unchanged";
  }

  #writeChange(series: StoredEvent, change: ImportedPart, now: number): void {
    this.#write(
      {
        ...series,
        title: change.title,
        location: change.location,
        notes: change.notes,
        recurrenceId: change.recurrenceId,
        time: change.time,
        rule: null,
        exdates: [],
        sequence: change.sequence,
        cancelled: false,
      },
      now,
    );
  }

  // A series counts once, however many dates it has or how many of them were changed.
  countEvents(): number {
    const [row] = this.#rows<{ total: number }>(
      "SELECT count(DISTINCT uid) AS total FROM events",
    );
    return row?.total ?? 0;
  }

  // Only a manager, and only once D1 no longer has the calendar. Everyone invited to its
  // events hears they're off, so this keeps what that needs.
  erase(actor: Actor, now: number): EraseResult {
    if (actor.role !== "manager") return { status: "noAccess" };
    const invited = this.#rows<PeopleRow>(
      "SELECT * FROM event_people WHERE reply IS NULL",
    );
    this.db.transaction(() => {
      for (const row of invited) {
        const people = JSON.parse(row.attendees) as StoredAttendee[];
        this.#queue(row.uid as EventUid, idsOf(people), actor.calendarId, now);
        this.db.exec(
          `INSERT INTO removed_events (uid, sequence, removed_at)
           SELECT uid, max(sequence), ? FROM events WHERE uid = ? GROUP BY uid
           ON CONFLICT (uid) DO UPDATE SET sequence = max(sequence, excluded.sequence)`,
          now,
          row.uid,
        );
      }
      this.db.exec("DELETE FROM events");
      this.db.exec("DELETE FROM event_people");
      this.db.exec("DELETE FROM removed_dates");
      this.db.exec(
        "DELETE FROM removed_events WHERE uid NOT IN (SELECT uid FROM deliveries)",
      );
    });
    return { status: "done" };
  }
}
