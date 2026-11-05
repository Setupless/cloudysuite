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
  type CancelledDate,
  type DeliveredPart,
  type Delivery,
  type DeliveryResult,
  type EmailMethod,
  type EmailPlan,
  type EmailPlanOrganiser,
  type Gone,
  type OutsideInvitation,
  type OutsidePart,
  type OutsideReply,
  type OutsideResult,
  type QueuedDelivery,
  type QueuedEmail,
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
  type EmailAddress,
  type EventDetails,
  type EventDraft,
  type EventTarget,
  type EventTime,
  type EventUid,
  type ImportSummary,
  type Invitee,
  keyOfPerson,
  MAX_OCCURRENCES,
  MAX_PERSON_NAME_LENGTH,
  type NotSent,
  type NotSentReason,
  type Occurrence,
  type OccurrenceId,
  type Organiser,
  type OutsideInviting,
  type OutsideRefused,
  type PersonKey,
  type PersonToInvite,
  type RangeListing,
  type Repeat,
  type RetryResult,
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
  conference: string | null;
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
  conference: event.conference,
});

export type EventGroup = {
  uid: EventUid;
  series: OutsideEvent | null;
  changes: OutsideEvent[];
};

// A file can hold the same event or date twice. The higher sequence wins, then the first.
export function groupByEvent(events: OutsideEvent[]): EventGroup[] {
  const groups = new Map<EventUid, EventGroup>();
  const newer = (held: OutsideEvent | null | undefined, part: OutsideEvent) =>
    !held || part.sequence > held.sequence;
  for (const part of events) {
    const group = groups.get(part.uid) ?? {
      uid: part.uid,
      series: null,
      changes: [],
    };
    groups.set(part.uid, group);
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

export const groupForImport = (events: OutsideEvent[]): ImportGroup[] =>
  groupByEvent(events).map((group) => ({
    uid: group.uid,
    series: group.series && partOf(group.series),
    changes: group.changes.map(partOf),
  }));

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
  conference: string | null;
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
  // Only a copy from outside has one.
  conference: string | null;
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
    conference: row.conference,
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

// As read, with the invitation emails that didn't go, which only the organiser's
// calendar has.
export type HeldPeople = People & { notSent: ReadonlyMap<PersonKey, NotSent> };

type PeopleRow = SqlRow & {
  uid: string;
  attendees: string;
  revision: number;
  reply: string | null;
};

type EmailRow = SqlRow & {
  uid: string;
  recipient: string;
  calendar_id: string;
  changed_by: string;
  version: number;
  state: string;
  tries: number;
  reason: string | null;
  sent: string | null;
  gone: string | null;
};

// What an email to someone about an event that's been deleted still needs.
type GoneEvent = {
  organiser: EmailPlanOrganiser;
  series: DeliveredPart;
  why: Gone;
};

// A claim that never finished is found by this wake-up, and only then, since one
// object's alarm handlers never overlap.
const SENDING_CHECK_MS = 60_000;

// Dates removed from a copy here, which no later change from its organiser brings back.
// Each is the day it was first on, so moving every date to a new time keeps it removed.
export type Removal = {
  dates: ReadonlySet<CivilDate>;
  from: CivilDate | null;
};

export function isRemovedHere(
  removal: Removal | undefined,
  series: StoredEvent,
  id: OccurrenceId,
): boolean {
  if (removal === undefined) return false;
  const day = startDateOf(timeOfDate(series, id));
  return (
    removal.dates.has(day) || (removal.from !== null && day >= removal.from)
  );
}

// This date and every later one were removed here.
export const isRemovedOnward = (
  removal: Removal | undefined,
  series: StoredEvent,
  id: OccurrenceId,
) =>
  removal !== undefined &&
  removal.from !== null &&
  startDateOf(timeOfDate(series, id)) >= removal.from;

const inUids = "uid IN (SELECT value FROM json_each(?))";

export function readPeople(
  db: SqlDriver,
  uids: readonly string[],
): Map<string, HeldPeople> {
  const notSent = new Map<string, Map<PersonKey, NotSent>>();
  for (const row of db
    .exec<{ uid: string; recipient: string; state: string; reason: string }>(
      `SELECT uid, recipient, state, reason FROM invitation_emails
       WHERE state IN ('refused', 'unclear') AND ${inUids}`,
      JSON.stringify(uids),
    )
    .toArray()) {
    const forEvent = notSent.get(row.uid) ?? new Map();
    notSent.set(row.uid, forEvent);
    forEvent.set(
      row.recipient as PersonKey,
      row.state === "unclear"
        ? { kind: "unclear" }
        : { kind: "refused", reason: row.reason as NotSentReason },
    );
  }
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
          // A copy's own queue holds only its answer to an organiser outside.
          notSent: (row.reply === null && notSent.get(row.uid)) || new Map(),
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
    { dates: Set<CivilDate>; from: CivilDate | null }
  >();
  for (const row of db
    .exec<{ uid: string; date: string; and_later: number }>(
      `SELECT uid, date, and_later FROM removed_dates WHERE ${inUids}`,
      JSON.stringify(uids),
    )
    .toArray()) {
    const removal = removals.get(row.uid) ?? { dates: new Set(), from: null };
    removals.set(row.uid, removal);
    const day = row.date as CivilDate;
    if (!row.and_later) removal.dates.add(day);
    else if (removal.from === null || day < removal.from) removal.from = day;
  }
  return removals;
}

const attendeeOf = ({ revision: _revision, ...attendee }: StoredAttendee) =>
  attendee as Attendee;

const deliveredPeople = (people: People): Attendee[] =>
  people.attendees.map(attendeeOf);

const shownPeople = (people: HeldPeople | undefined): Occurrence["people"] =>
  (people?.attendees ?? []).map((attendee) => ({
    ...attendeeOf(attendee),
    notSent: people?.notSent.get(keyOfPerson(attendee)) ?? null,
  }));

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
  people: HeldPeople | undefined,
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
  conference: event.conference,
});

const sameTime = (a: EventTime, b: EventTime) =>
  JSON.stringify(a) === JSON.stringify(b);

// Colleagues only, since only they have a calendar here to deliver a copy to.
const idsOf = (attendees: readonly StoredAttendee[]) =>
  attendees.flatMap((attendee) =>
    attendee.kind === "colleague" ? [attendee.userId] : [],
  );

const keysOf = (attendees: readonly StoredAttendee[]) =>
  attendees.map(keyOfPerson);

const samePeople = (
  a: readonly StoredAttendee[],
  b: readonly StoredAttendee[],
) => {
  const held = new Set(keysOf(a));
  return a.length === b.length && keysOf(b).every((key) => held.has(key));
};

type Planned =
  | { status: "planned"; attendees: StoredAttendee[] }
  | { status: "notInvitable" }
  | OutsideRefused;

// Who the dialog asked for, in its order. Someone already invited keeps their answer,
// even if they've since been suspended. Anyone new must be someone the directory offers,
// or an address while emails can go from the organiser's. The organiser is never one of
// their own guests.
function plannedPeople(
  requested: readonly PersonToInvite[],
  held: readonly StoredAttendee[],
  invitable: readonly Invitee[],
  organiser: UserId,
  // Whether emails can go from the organiser's address, which only a new address needs.
  outside: OutsideInviting,
): Planned {
  const planned: StoredAttendee[] = [];
  const asked = new Map(
    requested.map((person) => [keyOfPerson(person), person] as const),
  );
  for (const [key, person] of asked) {
    if (person === organiser) continue;
    const kept = held.find((attendee) => keyOfPerson(attendee) === key);
    if (kept) {
      planned.push(kept);
      continue;
    }
    if (typeof person !== "string") {
      if (outside !== "ready") {
        return { status: "outsideNotAllowed", why: outside };
      }
      planned.push({
        kind: "outside",
        email: person.email,
        name: person.email,
        answer: "needsAnswer",
        revision: 0,
      });
      continue;
    }
    const found = invitable.find((invitee) => invitee.userId === person);
    if (!found) return { status: "notInvitable" };
    planned.push({
      kind: "colleague",
      userId: person,
      name: found.name,
      answer: "needsAnswer",
      revision: 0,
    });
  }
  // Nothing changed, so the order they were first invited in stays.
  return {
    status: "planned",
    attendees: samePeople(held, planned) ? [...held] : planned,
  };
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
  conference: event.conference,
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
         updated_at, span_start, span_end, cancelled, conference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (uid, coalesce(recurrence_id, '')) DO UPDATE SET
         title = excluded.title, location = excluded.location, notes = excluded.notes,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at, tzid = excluded.tzid,
         start_date = excluded.start_date, end_date = excluded.end_date,
         rrule = excluded.rrule, exdates = excluded.exdates,
         organiser = excluded.organiser, sequence = excluded.sequence,
         updated_at = excluded.updated_at, span_start = excluded.span_start,
         span_end = excluded.span_end, cancelled = excluded.cancelled,
         conference = excluded.conference`,
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
      event.conference,
    );
  }

  // A list that empties keeps its row, so its revision keeps growing, and a copy takes the
  // list as newer once someone is put back on it.
  #writePeople(uid: EventUid, people: People): void {
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
  // Colleagues get their copy and an email, and people outside an email. The email is
  // written from the event as it is when it goes, like a copy, and goes from the
  // organiser's address whoever made the change. A change that only calls off one date
  // is a cancellation of that date, but only to someone whose last email went and left
  // them the event. Anyone else, or a second change before it goes, gets the whole
  // event as it is then.
  #queueFor(
    uid: EventUid,
    before: readonly StoredAttendee[],
    after: readonly StoredAttendee[],
    actor: Actor,
    now: number,
    cancelledDate: CancelledDate | null = null,
  ): void {
    this.#queue(
      uid,
      [...idsOf(before), ...idsOf(after)],
      actor.calendarId,
      now,
    );
    for (const recipient of new Set([...keysOf(before), ...keysOf(after)])) {
      this.db.exec(
        `INSERT INTO invitation_emails (uid, recipient, calendar_id, changed_by, version,
           state, tries, try_at)
         VALUES (?, ?, ?, ?, 1, 'queued', 0, ?)
         ON CONFLICT (uid, recipient) DO UPDATE SET version = version + 1,
           state = 'queued', tries = 0, try_at = excluded.try_at, reason = NULL,
           calendar_id = excluded.calendar_id, changed_by = excluded.changed_by,
           cancelled_date = CASE WHEN state = 'sent' AND sent = 'request' THEN ? END`,
        uid,
        recipient,
        actor.calendarId,
        actor.userId,
        now,
        cancelledDate && JSON.stringify(cancelledDate),
      );
    }
  }

  // Deleting an event takes its rows, so its cancellations keep what they need to say.
  #keepForCancelling(uid: EventUid, why: Gone): void {
    const series = this.#series(uid);
    if (!series || series.organiser.kind !== "madeHere") return;
    const gone: GoneEvent = {
      organiser: {
        userId: series.organiser.userId,
        name: series.organiser.name,
      },
      series: {
        ...deliveredPartOf(series),
        sequence: this.#nextSequence(uid),
      },
      why,
    };
    this.db.exec(
      "UPDATE invitation_emails SET gone = ? WHERE uid = ?",
      JSON.stringify(gone),
      uid,
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
          !isRemovedHere(removal, series, date.id) &&
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
    outside: OutsideInviting,
    now: number,
  ): CreateResult {
    if (!canEdit(actor)) return { status: "noAccess" };
    const planned = plannedPeople(
      draft.people,
      [],
      invitable,
      actor.userId,
      outside,
    );
    if (planned.status !== "planned") return planned;
    const { attendees } = planned;
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
          conference: null,
        },
        now,
      );
      if (attendees.length > 0) {
        this.#writePeople(uid, { attendees, revision: 1, reply: null });
      }
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
    outside: OutsideInviting,
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
    const planned = plannedPeople(
      draft.people,
      before,
      invitable,
      series.organiser.userId,
      outside,
    );
    if (planned.status !== "planned") return planned;
    const after = planned.attendees;
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
          conference: series.conference,
        },
        now,
      );
      if (carried.length > 0) {
        this.#writePeople(uid, {
          attendees: carried,
          revision: 1,
          reply: null,
        });
      }
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
        const [changed] = this.#rows<EventRow>(
          "SELECT * FROM events WHERE uid = ? AND recurrence_id = ?",
          series.uid,
          id,
        ).map(parseRow);
        const cancelled: CancelledDate = {
          ...deliveredPartOf(changed ?? series),
          recurrenceId: id,
          time: changed?.time ?? timeOfDate(series, id),
          rule: null,
          exdates: [],
          sequence,
        };
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
        this.#queueFor(series.uid, people, people, actor, now, cancelled);
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
        `INSERT INTO removed_dates (uid, date, and_later, removed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (uid, date) DO UPDATE SET
           and_later = max(and_later, excluded.and_later)`,
        series.uid,
        startDateOf(timeOfDate(series, id)),
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
        this.#keepForCancelling(uid, "deleted");
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
  // handed to someone else. The answer stays here. A notice takes it to a colleague who
  // organised it, and an email to an organiser outside, even when it's the answer already
  // shown, so pressing it again always reaches them. An event called off asks nothing.
  answer(
    actor: Actor,
    uid: EventUid,
    answer: Answer,
    now: number,
  ): AnswerResult {
    const series = this.#series(uid);
    const organiser = series?.organiser;
    const held = this.#people(uid);
    const reply = held?.reply;
    if (
      !organiser ||
      organiser.kind === "madeHere" ||
      series.cancelled ||
      !held ||
      !reply ||
      reply.for !== actor.userId
    ) {
      return { status: "gone" };
    }
    const given = { ...reply, answer, revision: reply.revision + 1 };
    this.db.transaction(() => {
      this.#writePeople(uid, {
        ...held,
        attendees: held.attendees.map((attendee) =>
          attendee.kind === "colleague" && attendee.userId === actor.userId
            ? { ...attendee, answer }
            : attendee,
        ),
        reply: given,
      });
      if (organiser.kind === "outside") {
        this.#queueReply(uid, organiser.email, actor, now);
        return;
      }
      this.db.exec(
        `INSERT INTO answer_notices (calendar_id, uid, attendee, answer, revision, tries, try_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (calendar_id, uid) DO UPDATE SET attendee = excluded.attendee,
           answer = excluded.answer, revision = excluded.revision, tries = 0,
           try_at = excluded.try_at`,
        organiser.calendarId,
        organiser.uid,
        actor.userId,
        answer,
        given.revision,
        now,
      );
    });
    return { status: "done" };
  }

  // The email is written from the answer as it is when it goes, like an invitation, so
  // a second answer before it goes sends only the second.
  #queueReply(
    uid: EventUid,
    organiser: EmailAddress,
    actor: Actor,
    now: number,
  ): void {
    this.db.exec(
      `INSERT INTO invitation_emails (uid, recipient, calendar_id, changed_by, version,
         state, tries, try_at)
       VALUES (?, ?, ?, ?, 1, 'queued', 0, ?)
       ON CONFLICT (uid, recipient) DO UPDATE SET version = version + 1,
         state = 'queued', tries = 0, try_at = excluded.try_at, reason = NULL,
         calendar_id = excluded.calendar_id, changed_by = excluded.changed_by`,
      uid,
      keyOfPerson({ email: organiser }),
      actor.calendarId,
      actor.userId,
      now,
    );
  }

  // `uid` is the copy's own here, from copyUidOf. A copy is written only over an earlier
  // copy from the same calendar. A part whose sequence is no higher than the one held
  // changes nothing, and a removed event or date stays removed.
  receiveInvitation(
    delivery: Delivery,
    uid: EventUid,
    now: number,
  ): DeliveryResult {
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
      uid: delivery.uid,
    };
    const copyOf = (part: DeliveredPart): StoredEvent => ({
      ...part,
      uid,
      organiser,
      cancelled: false,
    });
    let changed = false;
    this.db.transaction(() => {
      changed = this.#takeParts(
        held,
        copyOf,
        seriesPart,
        delivery.parts.filter((part) => part !== seriesPart),
        now,
      );
      const heldPeople = this.#people(uid);
      if (!heldPeople || delivery.peopleRevision > heldPeople.revision) {
        changed = true;
        const given = heldPeople?.reply;
        const [onItsWay] = this.#rows(
          "SELECT 1 FROM answer_notices WHERE calendar_id = ? AND uid = ?",
          delivery.from,
          delivery.uid,
        );
        const isReplier = (person: Attendee, replier: UserId) =>
          person.kind === "colleague" && person.userId === replier;
        const theirs = delivery.people.find((person) =>
          isReplier(person, delivery.to),
        );
        // The organiser's record of this person's answer, unless the one given here hasn't
        // reached the organiser yet. So someone taken off and put back is asked again.
        const reply: Reply = {
          ...(given ?? { for: delivery.to, revision: 0 }),
          answer:
            given && onItsWay
              ? given.answer
              : (theirs?.answer ?? "needsAnswer"),
        };
        this.#writePeople(uid, {
          attendees: delivery.people.map((person) => ({
            ...person,
            answer: isReplier(person, reply.for) ? reply.answer : person.answer,
            revision: 0,
          })),
          revision: delivery.peopleRevision,
          reply,
        });
      }
    });
    return changed ? "received" : "unchanged";
  }

  // The parts of a copy newer than those held, by UID and sequence, with `held` checked
  // as the same organiser's. The series is null when only some dates change. A newer
  // series comes with the whole event as the organiser has it now, so each changed date
  // with it counts, even one here that was called off with the event. Otherwise a
  // changed date counts only if it's newer than the series held too, since that series
  // may have dropped it. A removed date stays removed.
  #takeParts<Part extends DeliveredPart>(
    held: StoredEvent | null,
    copyOf: (part: Part) => StoredEvent,
    seriesPart: Part | null,
    changes: readonly Part[],
    now: number,
  ): boolean {
    const series = seriesPart && copyOf(seriesPart);
    const dates = series ?? held;
    if (!dates) return false;
    const removal = readRemovals(this.db, [dates.uid]).get(dates.uid);
    // A file can call a date off without raising the series' sequence, so a series at the
    // same sequence that has called off more dates is newer too.
    const newerSeries =
      series !== null &&
      (!held ||
        series.sequence > held.sequence ||
        (series.sequence === held.sequence &&
          series.exdates.some((id) => !held.exdates.includes(id))));
    if (newerSeries) {
      this.#replaceCopySeries(
        held,
        series,
        new Set([null, ...changes.map((part) => part.recurrenceId)]),
        removal,
        now,
      );
    }
    let changed = newerSeries;
    for (const part of changes) {
      const id = part.recurrenceId;
      if (id === null || isRemovedHere(removal, dates, id)) continue;
      const heldChange = this.#changeOf(dates.uid, id);
      if (
        !newerSeries &&
        part.sequence <=
          Math.max(held?.sequence ?? -1, heldChange?.sequence ?? -1)
      ) {
        continue;
      }
      changed = true;
      this.#write(copyOf(part), now);
    }
    return changed;
  }

  // A date the organiser has newly removed stays on the copy, marked as called off, so
  // someone who looks sees it was cancelled rather than finding it gone. A changed date
  // the organiser no longer has goes.
  #replaceCopySeries(
    held: StoredEvent | null,
    series: StoredEvent,
    delivered: ReadonlySet<OccurrenceId | null>,
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
          if (held.exdates.includes(id) || isRemovedHere(removal, series, id)) {
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
      (person) =>
        person.kind === "colleague" && person.userId === notice.attendee,
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

  // An invitation emailed from outside. `uid` is the copy's own here, from copyUidOf with
  // the organiser's address. Anyone can send a new one, which arrives unanswered. Only its
  // organiser, with the proof Mail checked, can change or call off one held here, and a
  // removed event or date stays removed.
  receiveOutsideInvitation(
    invitation: OutsideInvitation,
    uid: EventUid,
    now: number,
  ): OutsideResult {
    const { series } = invitation;
    if (this.#rows("SELECT 1 FROM removed_events WHERE uid = ?", uid).length) {
      return "unchanged";
    }
    const held = this.#series(uid);
    if (
      held &&
      (held.organiser.kind !== "outside" || !invitation.fromOrganiser)
    ) {
      return "refused";
    }
    const organiser: Organiser = {
      kind: "outside",
      ...invitation.organiser,
      uid: invitation.uid,
      fromOrganiser: invitation.fromOrganiser,
    };
    const copyOf = (part: OutsidePart): StoredEvent => ({
      ...part,
      uid,
      organiser,
    });
    const callsOff = invitation.method === "cancel" || series?.cancelled;
    // Anyone can send the first one, naming any organiser and any sequence, so a copy
    // that came without the organiser's proof gives way to their own invitation, whole.
    const unproved =
      held?.organiser.kind === "outside" && !held.organiser.fromOrganiser;
    if (!held || (unproved && !callsOff && series)) {
      // There's nothing to call off, or to change only some dates of.
      if (callsOff || !series) return "unchanged";
      this.db.transaction(() => {
        if (held) {
          this.db.exec("DELETE FROM events WHERE uid = ?", uid);
          this.db.exec("DELETE FROM event_people WHERE uid = ?", uid);
        }
        this.#takeParts(null, copyOf, series, invitation.changes, now);
        this.#takePeople(invitation, uid, undefined);
      });
      return held ? "updated" : "added";
    }
    const changed = this.db.transaction(() => {
      if (callsOff) return this.#callOffCopy(held, invitation, now);
      // Email can arrive out of order, so only a version newer than the cancellation
      // brings a cancelled event back.
      if (held.cancelled && (!series || series.sequence <= held.sequence)) {
        return false;
      }
      const parts = this.#takeParts(
        held,
        copyOf,
        series,
        invitation.changes,
        now,
      );
      // A change to who's invited needn't raise the sequence, so the list is taken at it.
      const people =
        series !== null &&
        series.sequence >= held.sequence &&
        this.#takePeople(invitation, uid, this.#people(uid));
      return parts || people;
    });
    return changed ? "updated" : "unchanged";
  }

  // The list as the organiser sent it. This person's answer is the one they gave here.
  #takePeople(
    invitation: OutsideInvitation,
    uid: EventUid,
    held: People | undefined,
  ) {
    const reply: Reply = held?.reply ?? {
      for: invitation.to,
      answer: "needsAnswer",
      revision: 0,
    };
    const attendees = invitation.people.map((person): StoredAttendee => ({
      ...person,
      answer:
        person.kind === "colleague" && person.userId === reply.for
          ? reply.answer
          : person.answer,
      revision: 0,
    }));
    if (held && JSON.stringify(held.attendees) === JSON.stringify(attendees)) {
      return false;
    }
    this.#writePeople(uid, {
      attendees,
      revision: (held?.revision ?? 0) + 1,
      reply,
    });
    return true;
  }

  // The whole event, against the series' sequence, which only grows, or some of its
  // dates, as RFC 5546 calls off a single instance. A called-off date stays on the copy,
  // marked as such. A cancelled event keeps the cancellation's sequence, which only a
  // newer version can pass.
  #callOffCopy(
    held: StoredEvent,
    invitation: OutsideInvitation,
    now: number,
  ): boolean {
    if (invitation.series) {
      if (held.sequence > invitation.series.sequence) return false;
      const [row] = this.#rows<{ settled: number }>(
        "SELECT min(cancelled) AS settled FROM events WHERE uid = ?",
        held.uid,
      );
      if (row?.settled === 1 && held.sequence >= invitation.series.sequence) {
        return false;
      }
      this.db.exec(
        "UPDATE events SET cancelled = 1, sequence = max(sequence, ?) WHERE uid = ?",
        invitation.series.sequence,
        held.uid,
      );
      return true;
    }
    if (held.rule === null) return false;
    const rule = held.rule;
    const removal = readRemovals(this.db, [held.uid]).get(held.uid);
    const budget: Budget = { steps: STEPS_PER_CALL };
    let changed = false;
    for (const part of invitation.changes) {
      const id = part.recurrenceId as OccurrenceId;
      const heldChange = this.#changeOf(held.uid, id);
      if (
        heldChange?.cancelled ||
        held.exdates.includes(id) ||
        isRemovedHere(removal, held, id) ||
        part.sequence < Math.max(held.sequence, heldChange?.sequence ?? -1) ||
        (!heldChange && indexOf(rule, held.time, id, budget) === null)
      ) {
        continue;
      }
      changed = true;
      this.#write(
        {
          ...(heldChange ?? held),
          recurrenceId: id,
          time: heldChange?.time ?? timeOfDate(held, id),
          rule: null,
          exdates: [],
          sequence: part.sequence,
          cancelled: true,
        },
        now,
      );
    }
    return changed;
  }

  // Someone outside answering an invitation this organiser sent from their address. Only
  // their own event takes it, and only for that address on its list. Everyone else
  // invited is sent the new list. True when the event is here, changed or not.
  receiveOutsideReply(
    reply: OutsideReply,
    calendarId: CalendarId,
    now: number,
  ): boolean {
    const series = this.#series(reply.uid);
    const held = this.#people(reply.uid);
    if (
      series?.organiser.kind !== "madeHere" ||
      series.organiser.userId !== reply.organiser ||
      !held ||
      held.reply
    ) {
      return false;
    }
    const attendee = held.attendees.find(
      (person) =>
        person.kind === "outside" && person.email === reply.attendee.email,
    );
    if (!attendee) return false;
    // Someone outside keeps the stamp of the answer held as its revision, so an earlier
    // answer that arrives late changes nothing.
    if (reply.stamp !== null && reply.stamp < attendee.revision) return true;
    // Their name is their address until an answer from them says more.
    const name =
      reply.attendee.name?.slice(0, MAX_PERSON_NAME_LENGTH) || attendee.name;
    const revision = reply.stamp ?? attendee.revision;
    if (
      attendee.answer === reply.answer &&
      attendee.name === name &&
      attendee.revision === revision
    ) {
      return true;
    }
    const attendees = held.attendees.map((person) =>
      person === attendee
        ? { ...person, answer: reply.answer, name, revision }
        : person,
    );
    this.db.transaction(() => {
      this.#writePeople(reply.uid, {
        attendees,
        revision: held.revision + 1,
        reply: null,
      });
      this.#queue(reply.uid, idsOf(attendees), calendarId, now);
    });
    return true;
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
      !people.attendees.some(
        (attendee) =>
          attendee.kind === "colleague" && attendee.userId === userId,
      )
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
      people: deliveredPeople(people),
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
      "DELETE FROM answer_notices WHERE calendar_id = ? AND uid = ? AND revision = ?",
      notice.calendarId,
      notice.uid,
      notice.revision,
    );
  }

  postponeAnswer(notice: AnswerNotice, now: number): void {
    const [row] = this.#rows<{ tries: number }>(
      "SELECT tries FROM answer_notices WHERE calendar_id = ? AND uid = ? AND revision = ?",
      notice.calendarId,
      notice.uid,
      notice.revision,
    );
    if (!row) return;
    this.db.exec(
      `UPDATE answer_notices SET tries = tries + 1, try_at = ?
       WHERE calendar_id = ? AND uid = ? AND revision = ?`,
      retryAt(now, row.tries),
      notice.calendarId,
      notice.uid,
      notice.revision,
    );
  }

  nextWakeUpAt(): number | null {
    const [row] = this.#rows<{ next: number | null }>(
      `SELECT min(next) AS next FROM (
         SELECT min(try_at) AS next FROM deliveries
         UNION ALL SELECT min(try_at) FROM answer_notices
         UNION ALL SELECT min(try_at) FROM invitation_emails
       )`,
    );
    return row?.next ?? null;
  }

  dueEmails(now: number, limit: number): QueuedEmail[] {
    return this.#rows<EmailRow>(
      `SELECT * FROM invitation_emails WHERE try_at <= ? ORDER BY try_at LIMIT ?`,
      now,
      limit,
    ).map((row) => ({
      uid: row.uid as EventUid,
      recipient: row.recipient as PersonKey,
      calendarId: row.calendar_id as CalendarId,
      changedBy: row.changed_by as UserId,
      version: row.version,
      state: row.state === "sending" ? "sending" : "queued",
      tries: row.tries,
      sent: row.sent as EmailMethod | null,
    }));
  }

  // The event as it is now, for one person, or the one date that was called off. Someone
  // no longer invited is told it's off, and so is everyone once it's deleted, but only if
  // anything reached them before. On a copy from outside, it's the answer as it is now.
  emailFor(queued: QueuedEmail): EmailPlan {
    const series = this.#series(queued.uid);
    if (series?.organiser.kind === "outside") {
      const { reply, attendees } = this.#people(queued.uid) ?? {};
      const { email, name, uid } = series.organiser;
      if (
        !reply ||
        reply.answer === "needsAnswer" ||
        queued.recipient !== keyOfPerson({ email })
      ) {
        return { method: "none" };
      }
      const named = attendees?.find(
        (person) => person.kind === "colleague" && person.userId === reply.for,
      );
      return {
        method: "reply",
        uid,
        by: reply.for,
        byName: named?.name ?? null,
        organiser: { email, name },
        series: deliveredPartOf(series),
        answer: reply.answer,
      };
    }
    if (series && series.organiser.kind !== "madeHere")
      return { method: "none" };
    const people = series && this.#people(queued.uid);
    const to = people?.attendees.find(
      (attendee) => keyOfPerson(attendee) === queued.recipient,
    );
    const [row] = this.#rows<{
      gone: string | null;
      cancelled_date: string | null;
    }>(
      "SELECT gone, cancelled_date FROM invitation_emails WHERE uid = ? AND recipient = ?",
      queued.uid,
      queued.recipient,
    );
    if (series && people && !people.reply && to) {
      const organiser = series.organiser as Extract<
        Organiser,
        { kind: "madeHere" }
      >;
      if (row?.cancelled_date) {
        return {
          method: "cancel",
          uid: queued.uid,
          organiser: { userId: organiser.userId, name: organiser.name },
          series: deliveredPartOf(series),
          date: JSON.parse(row.cancelled_date) as CancelledDate,
          to: queued.recipient,
          why: "dateCancelled",
        };
      }
      return {
        method: "request",
        uid: queued.uid,
        organiser: { userId: organiser.userId, name: organiser.name },
        parts: this.#rows<EventRow>(
          "SELECT * FROM events WHERE uid = ? ORDER BY recurrence_id IS NOT NULL, recurrence_id",
          queued.uid,
        )
          .map(parseRow)
          .map(deliveredPartOf),
        people: deliveredPeople(people),
        to: attendeeOf(to),
        first: queued.sent !== "request",
      };
    }
    if (queued.sent === null) return { method: "none" };
    if (series) {
      const organiser = series.organiser as Extract<
        Organiser,
        { kind: "madeHere" }
      >;
      return {
        method: "cancel",
        uid: queued.uid,
        organiser: { userId: organiser.userId, name: organiser.name },
        series: deliveredPartOf(series),
        to: queued.recipient,
        why: "uninvited",
      };
    }
    if (!row?.gone) return { method: "none" };
    const gone = JSON.parse(row.gone) as GoneEvent;
    return {
      method: "cancel",
      uid: queued.uid,
      organiser: gone.organiser,
      series: gone.series,
      to: queued.recipient,
      why: gone.why,
    };
  }

  // The record of intent, with what it says as what may have gone. Once this is on disk,
  // a crash can only lead to unclear, never to a second send. False when a change got
  // there first, which queued it again.
  claimEmail(queued: QueuedEmail, method: EmailMethod, now: number): boolean {
    return (
      this.#rows(
        `UPDATE invitation_emails SET state = 'sending', try_at = ?, sent = ?
         WHERE uid = ? AND recipient = ? AND version = ? AND state = 'queued'
         RETURNING 1`,
        now + SENDING_CHECK_MS,
        method,
        queued.uid,
        queued.recipient,
        queued.version,
      ).length > 0
    );
  }

  // Each of these settles only the version it was about. A change made while it was on
  // its way queued the newer one, which still goes.
  #settleEmail(
    queued: QueuedEmail,
    state: "sent" | "refused" | "unclear",
    reason: NotSentReason | null,
    sent: EmailMethod | null,
  ): void {
    this.db.exec(
      `UPDATE invitation_emails SET sent = ?,
         state = CASE WHEN version = ? THEN ? ELSE state END,
         reason = CASE WHEN version = ? THEN ? ELSE reason END,
         try_at = CASE WHEN version = ? THEN NULL ELSE try_at END
       WHERE uid = ? AND recipient = ?`,
      sent,
      queued.version,
      state,
      queued.version,
      reason,
      queued.version,
      queued.uid,
      queued.recipient,
    );
  }

  emailWent(queued: QueuedEmail, method: EmailMethod): void {
    this.#settleEmail(queued, "sent", null, method);
  }

  // It may have gone, so it's never sent again unless someone chooses Try again.
  emailUnclear(queued: QueuedEmail, method: EmailMethod): void {
    this.#settleEmail(queued, "unclear", null, method);
  }

  // Nothing went, so what reached them before is what still counts.
  refuseEmail(queued: QueuedEmail, reason: NotSentReason): void {
    this.#settleEmail(queued, "refused", reason, queued.sent);
  }

  refuseUnclaimedEmail(queued: QueuedEmail, reason: NotSentReason): void {
    this.db.exec(
      `UPDATE invitation_emails SET state = 'refused', reason = ?, try_at = NULL
       WHERE uid = ? AND recipient = ? AND version = ? AND state = 'queued'`,
      reason,
      queued.uid,
      queued.recipient,
      queued.version,
    );
  }

  // Nothing went, so what reached them before is what still counts.
  postponeEmail(queued: QueuedEmail, tryAt: number): void {
    this.db.exec(
      `UPDATE invitation_emails SET sent = ?,
         state = CASE WHEN version = ? THEN 'queued' ELSE state END,
         tries = CASE WHEN version = ? THEN tries + 1 ELSE tries END,
         try_at = CASE WHEN version = ? THEN ? ELSE try_at END
       WHERE uid = ? AND recipient = ?`,
      queued.sent,
      queued.version,
      queued.version,
      queued.version,
      tryAt,
      queued.uid,
      queued.recipient,
    );
  }

  // Nothing to say, or nobody to say it to, as to a colleague with no mailbox.
  dropEmail(queued: QueuedEmail): void {
    this.db.exec(
      "DELETE FROM invitation_emails WHERE uid = ? AND recipient = ? AND version = ?",
      queued.uid,
      queued.recipient,
      queued.version,
    );
  }

  // Only an email that didn't go, or may not have. One already on its way again, or
  // gone since, is left as it is, so pressing it twice sends once. Whoever chose it must
  // still be able to edit the calendar when it goes.
  retryEmail(
    actor: Actor,
    uid: EventUid,
    recipient: PersonKey,
    now: number,
  ): RetryResult {
    if (!canEdit(actor)) return { status: "noAccess" };
    const [row] = this.#rows<{ state: string }>(
      "SELECT state FROM invitation_emails WHERE uid = ? AND recipient = ?",
      uid,
      recipient,
    );
    if (!row) return { status: "gone" };
    this.db.exec(
      `UPDATE invitation_emails SET state = 'queued', tries = 0, try_at = ?,
         reason = NULL, changed_by = ?
       WHERE uid = ? AND recipient = ? AND state IN ('refused', 'unclear')`,
      now,
      actor.userId,
      uid,
      recipient,
    );
    return { status: "done" };
  }

  organiserOf(uid: EventUid): UserId | null {
    const series = this.#series(uid);
    return series?.organiser.kind === "madeHere"
      ? series.organiser.userId
      : null;
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
        conference: series.conference,
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
      this.#write({ ...before, exdates: [...before.exdates, id].sort() }, now);
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
        conference: change.conference,
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
        this.#queueFor(row.uid as EventUid, people, [], actor, now);
        this.#keepForCancelling(row.uid as EventUid, "calendarDeleted");
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
