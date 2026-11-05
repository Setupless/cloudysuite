import ICAL from "ical.js";
import type { DeliveredPart, EmailPlan } from "../invitations";
import { dateOfOccurrence, instantOfOccurrence, wallOf } from "../time";
import type {
  Answer,
  EmailAddress,
  EventTime,
  EventUid,
  OccurrenceId,
  TimeZone,
} from "../types";
import { timeZoneComponent } from "./vtimezone";

// iMIP, RFC 6047: an invitation, an update, or a cancellation as iCalendar, which any
// calendar or mail app can read and answer.

const PRODID = "-//CloudySuite//Calendar//EN";
// RFC 5545's limit, counted in octets without the line break. A continued line starts
// with a space, which counts.
const LINE_OCTETS = 75;

export type IcsPerson = {
  address: EmailAddress;
  name: string | null;
};

export type IcsAttendee = IcsPerson & { answer: Answer };

type IcsInput = {
  plan: Exclude<EmailPlan, { method: "none" }>;
  organiser: IcsPerson;
  // Everyone on a request, or the one person a cancellation is for.
  attendees: IcsAttendee[];
  stamp: number;
};

const PARTSTAT: Record<Answer, string> = {
  needsAnswer: "NEEDS-ACTION",
  yes: "ACCEPTED",
  maybe: "TENTATIVE",
  no: "DECLINED",
};

const pad = (value: number) => String(value).padStart(2, "0");

const isUtc = (zone: TimeZone) => zone === "UTC" || zone === "Etc/UTC";

// A timed value on the event's own clock, named by its zone.
function timeValue(
  instant: number,
  zone: TimeZone,
): { value: ICAL.Time; tzid: string | null } {
  if (isUtc(zone)) {
    return { value: ICAL.Time.fromJSDate(new Date(instant), true), tzid: null };
  }
  const wall = new Date(wallOf(instant, zone));
  return {
    value: ICAL.Time.fromDateTimeString(
      `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`,
    ),
    tzid: zone,
  };
}

function addTime(
  event: ICAL.Component,
  name: string,
  instant: number,
  zone: TimeZone,
): void {
  const property = new ICAL.Property(name);
  const { value, tzid } = timeValue(instant, zone);
  if (tzid) property.setParameter("tzid", tzid);
  property.setValue(value);
  event.addProperty(property);
}

function addDate(event: ICAL.Component, name: string, date: string): void {
  const property = new ICAL.Property(name);
  property.setValue(ICAL.Time.fromDateString(date));
  event.addProperty(property);
}

function addTimes(event: ICAL.Component, time: EventTime): void {
  if (time.kind === "allDay") {
    addDate(event, "dtstart", time.startDate);
    addDate(event, "dtend", time.endDate);
    return;
  }
  addTime(event, "dtstart", time.start, time.timeZone);
  addTime(event, "dtend", time.end, time.timeZone);
}

// A date of the series, named the way the series' own start is written.
function addDateOf(
  event: ICAL.Component,
  name: string,
  id: OccurrenceId,
  series: EventTime,
): void {
  if (series.kind === "allDay") addDate(event, name, dateOfOccurrence(id));
  else addTime(event, name, instantOfOccurrence(id), series.timeZone);
}

// Names come from the directory or from whoever typed them, so nothing in one can end
// the line or reorder it.
const cleanName = (name: string) =>
  name.replace(/[\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩]+/gu, " ").trim();

// ical.js escapes a line feed but writes a carriage return as it is, which some readers
// take as the end of the line. Line breaks become line feeds, and other breaks spaces.
const cleanText = (text: string) =>
  text.replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\t\n]|[\p{Zl}\p{Zp}]/gu, " ");

function addPerson(
  event: ICAL.Component,
  name: "organizer" | "attendee",
  person: IcsPerson,
  answer?: Answer,
): void {
  const property = new ICAL.Property(name);
  const shown = person.name && cleanName(person.name);
  if (shown) property.setParameter("cn", shown);
  if (answer) {
    property.setParameter("role", "REQ-PARTICIPANT");
    property.setParameter("partstat", PARTSTAT[answer]);
    property.setParameter("rsvp", "TRUE");
  }
  property.setValue(`mailto:${person.address}`);
  event.addProperty(property);
}

// A rule ical.js can't read is one Calendar shows only the first date of, so the email
// says the same.
function addRule(event: ICAL.Component, rule: string): void {
  let recur: ICAL.Recur;
  try {
    recur = ICAL.Recur.fromString(rule);
  } catch {
    return;
  }
  event.addPropertyWithValue("rrule", recur);
}

function eventOf(
  input: IcsInput,
  uid: EventUid,
  part: DeliveredPart,
  series: DeliveredPart,
  cancelled: boolean,
): ICAL.Component {
  const event = new ICAL.Component("vevent");
  event.addPropertyWithValue("uid", uid);
  event.addPropertyWithValue("sequence", part.sequence);
  event.addPropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(input.stamp), true),
  );
  if (part.recurrenceId) {
    addDateOf(event, "recurrence-id", part.recurrenceId, series.time);
  }
  addTimes(event, part.time);
  if (part.recurrenceId === null && part.rule !== null) {
    addRule(event, part.rule);
    for (const id of part.exdates) addDateOf(event, "exdate", id, part.time);
  }
  event.addPropertyWithValue("summary", cleanText(part.title));
  if (part.location) {
    event.addPropertyWithValue("location", cleanText(part.location));
  }
  if (part.notes) {
    event.addPropertyWithValue("description", cleanText(part.notes));
  }
  event.addPropertyWithValue("status", cancelled ? "CANCELLED" : "CONFIRMED");
  addPerson(event, "organizer", input.organiser);
  for (const attendee of input.attendees) {
    addPerson(event, "attendee", attendee, attendee.answer);
  }
  return event;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// ical.js folds a continued line one octet past the limit, so the lines are folded here,
// at whole characters.
function fold(line: string): string {
  const pieces: string[] = [];
  let piece = "";
  for (const character of line) {
    const limit = pieces.length === 0 ? LINE_OCTETS : LINE_OCTETS - 1;
    if (utf8Length(piece + character) > limit) {
      pieces.push(piece);
      piece = "";
    }
    piece += character;
  }
  pieces.push(piece);
  return pieces.join("\r\n ");
}

const zonesOf = (parts: DeliveredPart[]) => [
  ...new Set(
    parts.flatMap((part) =>
      part.time.kind === "timed" && !isUtc(part.time.timeZone)
        ? [part.time.timeZone]
        : [],
    ),
  ),
];

export function invitationIcs(input: IcsInput): string {
  const { plan } = input;
  const calendar = new ICAL.Component("vcalendar");
  calendar.addPropertyWithValue("prodid", PRODID);
  calendar.addPropertyWithValue("version", "2.0");
  calendar.addPropertyWithValue("calscale", "GREGORIAN");
  calendar.addPropertyWithValue(
    "method",
    plan.method === "request" ? "REQUEST" : "CANCEL",
  );
  const series =
    plan.method === "request" ? (plan.parts[0] as DeliveredPart) : plan.series;
  const parts =
    plan.method === "request"
      ? plan.parts
      : plan.why === "dateCancelled"
        ? [plan.date]
        : [plan.series];
  // A cancelled date is named on the series' own clock, which may not be its own.
  const timed = [series, ...parts];
  for (const zone of zonesOf(timed)) {
    const first = timed.find(
      (part) => part.time.kind === "timed" && part.time.timeZone === zone,
    )?.time as Extract<EventTime, { kind: "timed" }>;
    calendar.addSubcomponent(timeZoneComponent(zone, first.start));
  }
  for (const part of parts) {
    calendar.addSubcomponent(
      eventOf(input, plan.uid, part, series, plan.method === "cancel"),
    );
  }
  const unfolded = calendar.toString().replace(/\r\n[ \t]/g, "");
  return `${unfolded.split("\r\n").map(fold).join("\r\n")}\r\n`;
}
