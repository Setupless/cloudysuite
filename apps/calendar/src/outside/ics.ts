import ICAL from "ical.js";
import { parseEmailAddress } from "../email-address";
import { followableRule } from "../followable";
import { datesOf } from "../repeat";
import {
  addDays,
  allDayOccurrenceId,
  DAY_MS,
  dateOfWall,
  instantOf,
  parseCivilDate,
  parseTimeZone,
  timedOccurrenceId,
  type WallTime,
  wallOf,
  wallOfDate,
} from "../time";
import {
  type CivilDate,
  type EventDetails,
  type EventTime,
  type EventUid,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_EVENTS,
  MAX_LOCATION_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_UID_LENGTH,
  type OccurrenceId,
  type Shortfall,
  type SkipReason,
  type TimeZone,
} from "../types";
import { zoneOfTzid } from "./zones";

// Everything in a file from outside is hostile, like message content. This reads one
// into events in the store's shape, and skips what it can't read instead of failing.

const MAX_DEPTH = 8;
const MAX_RULE_TEXT = 1000;
const MAX_EXDATES = 2000;
const MAX_ATTENDEES = 200;
const MAX_NAME_LENGTH = 200;
const MAX_LINK_LENGTH = 2000;
const MAX_SEQUENCE = 2 ** 31 - 1;
// ical.js takes seconds over one line of a few megabytes, or of thousands of parameters.
// No line Calendar reads needs either, and notes are cut to 10,000 characters anyway.
const MAX_LINE_LENGTH = 32 * 1024;
const MAX_PARAMETERS = 200;
const UTC = parseTimeZone("UTC") as TimeZone;

// Google writes its Meet link here, and Outlook its Teams link.
const CONFERENCE_PROPERTIES = [
  "x-google-conference",
  "x-microsoft-skypeteamsmeetingurl",
];

// The properties read below. ical.js never sees the rest, such as an attachment
// written into the file.
const READ_PROPERTIES = new Set([
  "UID",
  "DTSTART",
  "DTEND",
  "DURATION",
  "RECURRENCE-ID",
  "EXDATE",
  "SUMMARY",
  "LOCATION",
  "DESCRIPTION",
  "SEQUENCE",
  "STATUS",
  "ORGANIZER",
  "ATTENDEE",
  ...CONFERENCE_PROPERTIES.map((name) => name.toUpperCase()),
]);

export type Answer = "accepted" | "tentative" | "declined" | "needsAction";
export type OutsidePerson = { email: string; name: string | null };
export type Attendee = OutsidePerson & { answer: Answer };

// One VEVENT: an event, a repeating series, or one changed date of a series.
export type OutsideEvent = EventDetails & {
  uid: EventUid;
  recurrenceId: OccurrenceId | null;
  time: EventTime;
  // Kept as written. Null for an event that doesn't repeat and for a changed date.
  rule: string | null;
  exdates: OccurrenceId[];
  sequence: number;
  // Null when Calendar shows every date the file gives.
  shortfall: Shortfall | null;
  cancelled: boolean;
  organiser: OutsidePerson | null;
  attendees: Attendee[];
  // Plain text, as hostile as the rest. A Join button checks its host.
  conference: string | null;
};

export type FileReading =
  | { status: "read"; events: OutsideEvent[]; skipped: SkipReason[] }
  | { status: "tooLarge" | "tooManyEvents" | "notCalendar" };

type Block = { name: string; lines: string[] };

// A day and time from the file. A wall time names no instant until its zone is known.
type Moment =
  | { kind: "date"; date: CivilDate }
  | { kind: "wall"; wall: WallTime; zone: TimeZone };

class Skip {
  constructor(readonly reason: SkipReason) {}
}

const skip = (reason: SkipReason): never => {
  throw new Skip(reason);
};

// Direction controls could reorder the letters of a title or an address.
const DIRECTION_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

const oneLine = (raw: string, longest: number) =>
  raw
    .replace(DIRECTION_CONTROLS, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, longest);

const notesText = (raw: string) =>
  raw
    .replace(DIRECTION_CONTROLS, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n]/gu, " ")
    .trim()
    .slice(0, MAX_NOTES_LENGTH);

// RFC 5545 folds a long line by starting the next one with a space or a tab.
const unfold = (text: string) =>
  text
    .replace(/^\ufeff/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");

const BEGIN = /^BEGIN:([A-Za-z0-9-]+)$/i;
const END = /^END:([A-Za-z0-9-]+)$/i;

// The events and time zones directly inside each VCALENDAR. An event keeps only its own
// lines, so an alarm or any other part inside it is never read.
function blocksOf(lines: string[]): Block[] | "notCalendar" | "tooManyEvents" {
  const blocks: Block[] = [];
  const stack: string[] = [];
  let events = 0;
  let calendars = 0;
  let current: Block | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const begin = BEGIN.exec(line)?.[1]?.toUpperCase();
    const end = END.exec(line)?.[1]?.toUpperCase();
    if (begin) {
      if (stack.length === 0 && begin !== "VCALENDAR") return "notCalendar";
      if (stack.length >= MAX_DEPTH) return "notCalendar";
      stack.push(begin);
      if (stack.length === 1) calendars++;
      if (stack.length === 2) {
        if (begin === "VEVENT" && ++events > MAX_IMPORT_EVENTS) {
          return "tooManyEvents";
        }
        current = { name: begin, lines: [] };
      }
      if (current?.name === "VTIMEZONE" && stack.length > 2) {
        current.lines.push(line);
      }
      continue;
    }
    if (end) {
      if (stack.at(-1) !== end) return "notCalendar";
      if (current?.name === "VTIMEZONE" && stack.length > 2) {
        current.lines.push(line);
      }
      if (stack.length === 2 && current) {
        blocks.push(current);
        current = null;
      }
      stack.pop();
      continue;
    }
    if (stack.length === 0) return "notCalendar";
    if (current && (stack.length === 2 || current.name === "VTIMEZONE")) {
      current.lines.push(line);
    }
  }
  return stack.length === 0 && calendars > 0 ? blocks : "notCalendar";
}

const valueOf = (line: string) => {
  const colon = line.indexOf(":");
  return colon === -1 ? "" : line.slice(colon + 1);
};

const nameOf = (line: string) =>
  (/^([A-Za-z0-9-]+)/.exec(line)?.[1] ?? "").toUpperCase();

const OFFSET = /^([+-])(\d{2})(\d{2})(\d{2})?$/;

// A zone Calendar can't name is read at its standard offset all year, from the file's
// own description of it. Its summer dates may then be an hour out, but every date of
// one event moves together, so a changed date still finds the date it changes.
type Observance = { standard: boolean; since: string; offset: string };

function fixedZoneOf(lines: string[]): [string, TimeZone] | null {
  let tzid: string | null = null;
  const offsets: Observance[] = [];
  let observance: Observance | null = null;
  for (const line of lines) {
    const name = nameOf(line);
    if (BEGIN.test(line)) {
      const kind = BEGIN.exec(line)?.[1]?.toUpperCase();
      observance =
        kind === "STANDARD" || kind === "DAYLIGHT"
          ? { standard: kind === "STANDARD", since: "", offset: "" }
          : null;
    } else if (END.test(line)) {
      if (observance) offsets.push(observance);
      observance = null;
    } else if (!observance && name === "TZID") {
      tzid = valueOf(line)
        .replace(/\\([,;\\])/g, "$1")
        .trim();
    } else if (observance && name === "DTSTART") {
      observance.since = valueOf(line);
    } else if (observance && name === "TZOFFSETTO") {
      observance.offset = valueOf(line).trim();
    }
  }
  const latest = (standard: boolean) =>
    offsets
      .filter(
        (entry) => entry.standard === standard && OFFSET.test(entry.offset),
      )
      .sort((a, b) => b.since.localeCompare(a.since))[0];
  const chosen = latest(true) ?? latest(false);
  const match = chosen && OFFSET.exec(chosen.offset);
  if (!tzid || !match || Number(match[2]) > 14 || Number(match[3]) > 59) {
    return null;
  }
  const zone = parseTimeZone(`${match[1]}${match[2]}:${match[3]}`);
  return zone ? [tzid, zone] : null;
}

const DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_VALUE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z?)$/;

type Zones = { inFile: Map<string, TimeZone>; floating: TimeZone };

function dateOf(year: string, month: string, day: string): CivilDate {
  const date = parseCivilDate(`${year}-${month}-${day}`);
  if (date) return date;
  const yearNumber = Number(year);
  return skip(
    yearNumber < 1900 || yearNumber > 2199 ? "outOfRange" : "unreadable",
  );
}

// ical.js would quietly move the 30th of February to March, so its raw text is read here.
function momentOf(
  type: string,
  raw: unknown,
  tzid: unknown,
  zones: Zones,
): Moment {
  if (typeof raw !== "string") return skip("unreadable");
  if (type === "date") {
    const match = DATE_VALUE.exec(raw);
    if (!match) return skip("unreadable");
    return {
      kind: "date",
      date: dateOf(match[1] as string, match[2] as string, match[3] as string),
    };
  }
  const match = type === "date-time" ? DATE_TIME_VALUE.exec(raw) : null;
  if (!match) return skip("unreadable");
  const [hour, minute, second] = [match[4], match[5], match[6]].map(Number) as [
    number,
    number,
    number,
  ];
  if (hour > 23 || minute > 59 || second > 59) return skip("unreadable");
  const date = dateOf(
    match[1] as string,
    match[2] as string,
    match[3] as string,
  );
  const wall = (wallOfDate(date) +
    ((hour * 60 + minute) * 60 + second) * 1000) as WallTime;
  const named = typeof tzid === "string" ? tzid : null;
  const zone =
    match[7] === "Z"
      ? UTC
      : named === null
        ? zones.floating
        : (zoneOfTzid(named) ?? zones.inFile.get(named) ?? zones.floating);
  return { kind: "wall", wall, zone };
}

function momentsOf(
  event: ICAL.Component,
  name: string,
  zones: Zones,
): Moment[] {
  return event.getAllProperties(name).flatMap((property) => {
    const tzid = property.getParameter("tzid");
    return property.jCal
      .slice(3)
      .map((raw) => momentOf(property.type, raw, tzid, zones));
  });
}

function firstMoment(event: ICAL.Component, name: string, zones: Zones) {
  const property = event.getFirstProperty(name);
  if (!property) return null;
  return momentOf(
    property.type,
    property.jCal[3],
    property.getParameter("tzid"),
    zones,
  );
}

const inRange = (instant: number) =>
  Number.isFinite(instant) &&
  parseCivilDate(new Date(instant).toISOString().slice(0, 10)) !== null;

function timeOf(
  start: Moment,
  end: Moment | null,
  duration: number | null,
): EventTime {
  if (start.kind === "date") {
    const days =
      end?.kind === "date"
        ? Math.round((wallOfDate(end.date) - wallOfDate(start.date)) / DAY_MS)
        : end
          ? skip("unreadable")
          : duration === null
            ? 1
            : Math.ceil(duration / DAY_MS);
    if (days < 0) skip("endsBeforeStart");
    const endDate =
      parseCivilDate(addDays(start.date, Math.max(days, 1))) ??
      skip("outOfRange");
    return { kind: "allDay", startDate: start.date, endDate };
  }
  const startsAt = instantOf(start.wall, start.zone);
  const endsAt =
    end?.kind === "wall"
      ? instantOf(end.wall, end.zone)
      : end
        ? skip("unreadable")
        : startsAt + (duration ?? 0);
  if (!inRange(startsAt) || !inRange(endsAt)) skip("outOfRange");
  if (endsAt < startsAt) skip("endsBeforeStart");
  // The store needs an end after the start. A millisecond shows as no length at all.
  const finish = endsAt === startsAt ? endsAt + 1 : endsAt;
  return { kind: "timed", start: startsAt, end: finish, timeZone: start.zone };
}

// A changed or removed date of a series, named the way the store names its dates.
function occurrenceOf(moment: Moment, series: EventTime): OccurrenceId {
  if (series.kind === "allDay") {
    return allDayOccurrenceId(
      moment.kind === "date" ? moment.date : dateOfWall(moment.wall),
    );
  }
  if (moment.kind === "wall") {
    return timedOccurrenceId(instantOf(moment.wall, moment.zone));
  }
  const startWall = wallOf(series.start, series.timeZone);
  const timeOfDay = startWall - wallOfDate(dateOfWall(startWall));
  return timedOccurrenceId(
    instantOf(
      (wallOfDate(moment.date) + timeOfDay) as WallTime,
      series.timeZone,
    ),
  );
}

function personOf(property: ICAL.Property): OutsidePerson | null {
  const email = parseEmailAddress(property.getFirstValue());
  if (!email) return null;
  const cn = property.getParameter("cn");
  const name = typeof cn === "string" ? oneLine(cn, MAX_NAME_LENGTH) : "";
  return { email, name: name === "" ? null : name };
}

const ANSWERS: Record<string, Answer> = {
  ACCEPTED: "accepted",
  TENTATIVE: "tentative",
  DECLINED: "declined",
};

function attendeesOf(event: ICAL.Component): Attendee[] {
  return event
    .getAllProperties("attendee")
    .slice(0, MAX_ATTENDEES)
    .flatMap((property) => {
      const person = personOf(property);
      const partstat = property.getParameter("partstat");
      const answer =
        (typeof partstat === "string" && ANSWERS[partstat.toUpperCase()]) ||
        "needsAction";
      return person ? [{ ...person, answer }] : [];
    });
}

const textOf = (event: ICAL.Component, name: string) => {
  const value = event.getFirstPropertyValue(name);
  return typeof value === "string" ? value : "";
};

function uidOf(event: ICAL.Component): EventUid {
  const uid = textOf(event, "uid").trim();
  if (uid === "" || uid.length > MAX_UID_LENGTH || /\p{Cc}/u.test(uid)) {
    return skip("noId");
  }
  return uid as EventUid;
}

function sequenceOf(event: ICAL.Component): number {
  const value = event.getFirstPropertyValue("sequence");
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return Math.min(value, MAX_SEQUENCE);
}

const PRINTABLE_RULE = /^[\x21-\x7e]+$/;

// Stops counting once there are too many, so a long line costs no more than its length.
function tooManyParameters(line: string): boolean {
  let count = 0;
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (character === ":") return false;
    else if (character === ";" && ++count > MAX_PARAMETERS) return true;
  }
  return false;
}

function readEvent(block: Block, zones: Zones): OutsideEvent {
  // ical.js reads a rule as it parses, and one it rejects would lose the whole event, so
  // the rule's own text is kept apart and never parsed here.
  const rules = block.lines
    .filter((line) => nameOf(line) === "RRULE")
    .map((line) => valueOf(line).trim());
  const extraDates = block.lines.some((line) =>
    ["RDATE", "EXRULE"].includes(nameOf(line)),
  );
  const read = block.lines.filter((line) => READ_PROPERTIES.has(nameOf(line)));
  if (
    read.some(
      (line) => line.length > MAX_LINE_LENGTH || tooManyParameters(line),
    )
  ) {
    skip("tooComplex");
  }
  let event: ICAL.Component;
  try {
    event = new ICAL.Component(
      ICAL.parse(["BEGIN:VEVENT", ...read, "END:VEVENT"].join("\r\n")),
    );
  } catch {
    return skip("unreadable");
  }

  const uid = uidOf(event);
  const start = firstMoment(event, "dtstart", zones) ?? skip("noStart");
  const durationValue = event.getFirstPropertyValue("duration");
  const time = timeOf(
    start,
    firstMoment(event, "dtend", zones),
    durationValue instanceof ICAL.Duration
      ? durationValue.toSeconds() * 1000
      : null,
  );
  const changed = firstMoment(event, "recurrence-id", zones);
  const range = event.getFirstProperty("recurrence-id")?.getParameter("range");
  if (range !== undefined && range !== null) skip("unreadable");
  const recurrenceId = changed && occurrenceOf(changed, time);

  const [ruleText] = rules;
  const rule = recurrenceId || ruleText === undefined ? null : ruleText;
  if (
    rule !== null &&
    (rule.length > MAX_RULE_TEXT || !PRINTABLE_RULE.test(rule))
  ) {
    skip("unreadable");
  }
  const followable = rule !== null && followableRule(rule) !== null;
  if (followable && datesOf(rule, time, { steps: 1 }).next().done) {
    skip("neverHappens");
  }
  const exdates =
    rule === null
      ? []
      : [
          ...new Set(
            momentsOf(event, "exdate", zones).map((moment) =>
              occurrenceOf(moment, time),
            ),
          ),
        ].sort();
  if (exdates.length > MAX_EXDATES) skip("unreadable");

  const organiser = event.getFirstProperty("organizer");
  const conference = CONFERENCE_PROPERTIES.map((name) =>
    oneLine(textOf(event, name), MAX_LINK_LENGTH),
  ).find((link) => link !== "");
  return {
    uid,
    recurrenceId,
    title: oneLine(textOf(event, "summary"), MAX_TITLE_LENGTH),
    location: oneLine(textOf(event, "location"), MAX_LOCATION_LENGTH),
    notes: notesText(textOf(event, "description")),
    time,
    rule,
    exdates,
    sequence: sequenceOf(event),
    shortfall:
      rule === null
        ? null
        : !followable
          ? "firstDateOnly"
          : extraDates || rules.length > 1
            ? "mainRepeatOnly"
            : null,
    cancelled: textOf(event, "status").toUpperCase() === "CANCELLED",
    organiser: organiser ? personOf(organiser) : null,
    attendees: attendeesOf(event),
    conference: conference ?? null,
  };
}

// `floating` is the zone for a time the file gives without one, the importer's own.
export function readCalendarFile(
  text: string,
  floating: TimeZone,
): FileReading {
  if (
    text.length > MAX_IMPORT_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES
  ) {
    return { status: "tooLarge" };
  }
  const blocks = blocksOf(unfold(text));
  if (typeof blocks === "string") return { status: blocks };
  const zones: Zones = {
    inFile: new Map(
      blocks.flatMap((block) => {
        const zone = block.name === "VTIMEZONE" && fixedZoneOf(block.lines);
        return zone ? [zone] : [];
      }),
    ),
    floating,
  };
  const events: OutsideEvent[] = [];
  const skipped: SkipReason[] = [];
  for (const block of blocks) {
    if (block.name !== "VEVENT") continue;
    try {
      events.push(readEvent(block, zones));
    } catch (thrown) {
      skipped.push(thrown instanceof Skip ? thrown.reason : "unreadable");
    }
  }
  return { status: "read", events, skipped };
}
