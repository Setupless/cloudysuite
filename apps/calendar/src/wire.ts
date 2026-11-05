import {
  type CalendarId,
  type CalendarRole,
  parseCalendarId,
  type UserId,
} from "@cloudysuite/access";
import { CALENDAR_ROLES } from "../../../src/db/schema";
import {
  parseCivilDate,
  parseOccurrenceId,
  parseTimeZone,
  startDateOf,
} from "./time";
import {
  type ChangeScope,
  type CivilDate,
  type DayRange,
  type EventDraft,
  type EventTarget,
  type EventTime,
  type EventUid,
  IMPORT_TOO_LARGE_MESSAGE,
  keyOfPerson,
  MAX_IMPORT_BYTES,
  GIVEN_ANSWERS,
  MAX_INVITED,
  MAX_LOCATION_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_REPEAT_TIMES,
  MAX_TITLE_LENGTH,
  MAX_UID_LENGTH,
  NOT_AN_ADDRESS_MESSAGE,
  type PersonKey,
  type PersonToInvite,
  REPEAT_FREQUENCIES,
  type Repeat,
  type RepeatEnd,
  type TimeZone,
} from "./types";
import { parseEmailAddress } from "./email-address";
import { MAX_SEARCH_LENGTH } from "./search-query";

const MAX_TIME_ZONE_LENGTH = 64;
const MAX_EMAIL_LENGTH = 254;
const MAX_CALENDAR_NAME_LENGTH = 100;
const MAX_USER_ID_LENGTH = 128;
const MAX_PEOPLE = 100;
const MINUTE_MS = 60_000;
const SCOPES: readonly ChangeScope[] = ["this", "thisAndLater", "all"];

export function refusal(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const badRequest = () => refusal(400, "That request isn't valid.");

const record = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null) throw badRequest();
  return raw as Record<string, unknown>;
};

function text(raw: unknown, longest: number): string {
  if (typeof raw !== "string" || raw.length > longest) throw badRequest();
  return raw;
}

function requireCalendarId(raw: unknown): CalendarId {
  const id = typeof raw === "string" ? parseCalendarId(raw) : null;
  if (!id) throw badRequest();
  return id;
}

function requireUserId(raw: unknown): UserId {
  const id = text(raw, MAX_USER_ID_LENGTH);
  if (id === "") throw badRequest();
  return id as UserId;
}

function requireDate(raw: unknown): CivilDate {
  const date = typeof raw === "string" ? parseCivilDate(raw) : null;
  if (!date) throw badRequest();
  return date;
}

function requireRole(raw: unknown): CalendarRole {
  if (!CALENDAR_ROLES.includes(raw as CalendarRole)) throw badRequest();
  return raw as CalendarRole;
}

// Whole minutes inside the years a date may use, so every start names its RECURRENCE-ID
// exactly.
function requireInstant(raw: unknown): number {
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw % MINUTE_MS !== 0 ||
    !parseCivilDate(new Date(raw).toISOString().slice(0, 10))
  ) {
    throw badRequest();
  }
  return raw;
}

export function parseCalendarName(raw: unknown): string {
  const name = text(raw, MAX_CALENDAR_NAME_LENGTH * 4).trim();
  if (name === "") throw refusal(400, "Give the calendar a name.");
  if (name.length > MAX_CALENDAR_NAME_LENGTH) {
    throw refusal(
      400,
      `Use a name of ${MAX_CALENDAR_NAME_LENGTH} characters or fewer.`,
    );
  }
  return name;
}

export const parseCalendarInput = (raw: unknown) => ({
  calendarId: requireCalendarId(record(raw).calendarId),
});

export const parseNewTeamCalendarInput = (raw: unknown) => ({
  name: parseCalendarName(record(raw).name),
});

export const parseRenameInput = (raw: unknown) => ({
  ...parseCalendarInput(raw),
  name: parseCalendarName(record(raw).name),
});

export function parseColourInput(raw: unknown) {
  const { colour } = record(raw);
  if (
    typeof colour !== "number" ||
    !Number.isInteger(colour) ||
    colour < 1 ||
    colour > 6
  ) {
    throw badRequest();
  }
  return { ...parseCalendarInput(raw), colour };
}

export function parseHiddenInput(raw: unknown) {
  const { hidden } = record(raw);
  if (typeof hidden !== "boolean") throw badRequest();
  return { ...parseCalendarInput(raw), hidden };
}

export const parseMemberInput = (raw: unknown) => ({
  ...parseCalendarInput(raw),
  userId: requireUserId(record(raw).userId),
});

export const parseMemberRoleInput = (raw: unknown) => ({
  ...parseMemberInput(raw),
  role: requireRole(record(raw).role),
});

export function parseAddMembersInput(raw: unknown) {
  const { people, role } = record(raw);
  if (
    !Array.isArray(people) ||
    people.length === 0 ||
    people.length > MAX_PEOPLE
  ) {
    throw badRequest();
  }
  return {
    ...parseCalendarInput(raw),
    people: [...new Set(people.map(requireUserId))],
    role: requireRole(role),
  };
}

export function parseRangeInput(raw: unknown): DayRange {
  const input = record(raw);
  const from = requireDate(input.from);
  const to = requireDate(input.to);
  const timeZone =
    typeof input.timeZone === "string" ? parseTimeZone(input.timeZone) : null;
  if (!timeZone || to <= from) throw badRequest();
  return { from, to, timeZone };
}

// Any text is a fair thing to search for. It's cut one past the limit, so an enormous
// string never crosses to a Calendar object and the parser still sees it was too long.
// A zone this runtime doesn't know reads the reader's days in UTC, which only decides
// whether an all-day event a few hours either side of now counts as past.
export function parseEventSearchInput(raw: unknown) {
  const input = record(raw);
  if (typeof input.text !== "string") throw badRequest();
  const zone =
    typeof input.timeZone === "string" &&
    input.timeZone.length <= MAX_TIME_ZONE_LENGTH
      ? parseTimeZone(input.timeZone)
      : null;
  return {
    text: input.text.slice(0, MAX_SEARCH_LENGTH + 1),
    timeZone: zone ?? ("UTC" as TimeZone),
  };
}

// The file's size in bytes is checked again once read. This only stops a huge one early.
export function parseImportInput(raw: unknown) {
  const input = record(raw);
  const timeZone =
    typeof input.timeZone === "string" ? parseTimeZone(input.timeZone) : null;
  if (typeof input.file !== "string" || !timeZone) throw badRequest();
  if (input.file.length > MAX_IMPORT_BYTES) {
    throw refusal(413, IMPORT_TOO_LARGE_MESSAGE);
  }
  return { ...parseCalendarInput(raw), file: input.file, timeZone };
}

function parseTime(raw: unknown): EventTime {
  const input = record(raw);
  if (input.kind === "allDay") {
    const startDate = requireDate(input.startDate);
    const endDate = requireDate(input.endDate);
    if (endDate <= startDate) {
      throw refusal(400, "The event has to end after the day it starts.");
    }
    return { kind: "allDay", startDate, endDate };
  }
  if (input.kind !== "timed") throw badRequest();
  const start = requireInstant(input.start);
  const end = requireInstant(input.end);
  const timeZone =
    typeof input.timeZone === "string" ? parseTimeZone(input.timeZone) : null;
  if (!timeZone) throw badRequest();
  if (end <= start) throw refusal(400, "The event has to end after it starts.");
  return { kind: "timed", start, end, timeZone };
}

function parseRepeatEnd(raw: unknown, time: EventTime): RepeatEnd {
  const input = record(raw);
  switch (input.kind) {
    case "never":
      return { kind: "never" };
    case "onDate": {
      const date = requireDate(input.date);
      if (date < startDateOf(time)) {
        throw refusal(400, "The repeat can't end before the event starts.");
      }
      return { kind: "onDate", date };
    }
    case "afterTimes": {
      const { times } = input;
      if (
        typeof times !== "number" ||
        !Number.isInteger(times) ||
        times < 1 ||
        times > MAX_REPEAT_TIMES
      ) {
        throw refusal(
          400,
          `A repeat can happen from 1 to ${MAX_REPEAT_TIMES} times.`,
        );
      }
      return { kind: "afterTimes", times };
    }
    default:
      throw badRequest();
  }
}

function parseRepeat(raw: unknown, time: EventTime): Repeat | null {
  if (raw === null) return null;
  const input = record(raw);
  const frequency = REPEAT_FREQUENCIES.find((name) => name === input.frequency);
  if (!frequency) throw badRequest();
  return { frequency, end: parseRepeatEnd(input.end, time) };
}

function parseDraft(raw: unknown): EventDraft {
  const input = record(raw);
  const title = text(input.title, MAX_TITLE_LENGTH * 4).trim();
  if (title === "") throw refusal(400, "Give the event a title.");
  if (title.length > MAX_TITLE_LENGTH) {
    throw refusal(
      400,
      `Use a title of ${MAX_TITLE_LENGTH} characters or fewer.`,
    );
  }
  const time = parseTime(input.time);
  const { people } = input;
  if (!Array.isArray(people) || people.length > MAX_INVITED) {
    throw badRequest();
  }
  const asked = new Map(
    people
      .map(parsePersonToInvite)
      .map((person) => [keyOfPerson(person), person]),
  );
  return {
    title,
    location: text(input.location, MAX_LOCATION_LENGTH).trim(),
    notes: text(input.notes, MAX_NOTES_LENGTH),
    time,
    repeat: parseRepeat(input.repeat, time),
    people: [...asked.values()],
  };
}

// A colleague's id, or { email } for anyone else.
function parsePersonToInvite(raw: unknown): PersonToInvite {
  if (typeof raw === "string") return requireUserId(raw);
  const email = parseEmailAddress(
    typeof record(raw).email === "string"
      ? text(record(raw).email, MAX_EMAIL_LENGTH)
      : null,
  );
  if (!email) throw refusal(400, NOT_AN_ADDRESS_MESSAGE);
  return { email };
}

function parseTarget(raw: unknown): EventTarget {
  const input = record(raw);
  const uid = text(input.uid, MAX_UID_LENGTH);
  if (uid === "") throw badRequest();
  if (input.occurrenceId === null) {
    return { uid: uid as EventUid, occurrenceId: null };
  }
  const occurrenceId =
    typeof input.occurrenceId === "string"
      ? parseOccurrenceId(input.occurrenceId)
      : null;
  if (!occurrenceId) throw badRequest();
  return { uid: uid as EventUid, occurrenceId };
}

function parseScope(raw: unknown): ChangeScope {
  const scope = SCOPES.find((name) => name === raw);
  if (!scope) throw badRequest();
  return scope;
}

export const parseNewEventInput = (raw: unknown) => ({
  ...parseCalendarInput(raw),
  draft: parseDraft(record(raw).draft),
});

export const parseEventChangeInput = (raw: unknown) => ({
  ...parseNewEventInput(raw),
  target: parseTarget(record(raw).target),
  scope: parseScope(record(raw).scope),
});

export const parseEventRemovalInput = (raw: unknown) => ({
  ...parseCalendarInput(raw),
  target: parseTarget(record(raw).target),
  scope: parseScope(record(raw).scope),
});

export function parseAnswerInput(raw: unknown) {
  const answer = GIVEN_ANSWERS.find((name) => name === record(raw).answer);
  if (!answer) throw badRequest();
  return {
    ...parseCalendarInput(raw),
    uid: parseTarget({ uid: record(raw).uid, occurrenceId: null }).uid,
    answer,
  };
}

export const parseOrganiserInput = (raw: unknown) => ({
  organiser: requireUserId(record(raw).organiser),
});

export function parseRetryEmailInput(raw: unknown) {
  const { recipient } = record(raw);
  const key = typeof recipient === "string" ? recipient : "";
  if (key.startsWith("user:")) requireUserId(key.slice(5));
  else if (
    !key.startsWith("mailto:") ||
    parseEmailAddress(key.slice(7)) !== key.slice(7)
  ) {
    throw badRequest();
  }
  return {
    ...parseCalendarInput(raw),
    uid: parseTarget({ uid: record(raw).uid, occurrenceId: null }).uid,
    recipient: key as PersonKey,
  };
}

export function parseInvitationsInput(raw: unknown) {
  const { timeZone } = record(raw);
  const zone =
    typeof timeZone === "string" && timeZone.length <= MAX_TIME_ZONE_LENGTH
      ? parseTimeZone(timeZone)
      : null;
  if (!zone) throw badRequest();
  return { timeZone: zone };
}
