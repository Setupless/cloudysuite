import { type CalendarId, levelOfRole, type UserId } from "@cloudysuite/access";
import {
  addDays,
  dateOfWall,
  instantOf,
  parseCivilDate,
  type WallTime,
  wallOf,
  wallOfDate,
} from "../time";
import {
  type CalendarEntry,
  type CalendarOccurrence,
  type ChangeScope,
  type CivilDate,
  type EmailAddress,
  type EventDraft,
  type EventTarget,
  type EventTime,
  keyOfPerson,
  MAX_REPEAT_TIMES,
  type NoDatesLeft,
  type Occurrence,
  type PersonToInvite,
  type Repeat,
  type RepeatEnd,
  type RepeatFrequency,
  type TimeZone,
} from "../types";
import { dayTitle } from "./event-text";

const MINUTE_MS = 60_000;
const SLOT_MINUTES = 30;
const SLOTS_IN_DAY = (24 * 60) / SLOT_MINUTES;
const LENGTH_MINUTES = 60;
const CLOCK = /^(\d{2}):(\d{2})(?::\d{2})?$/;

// Where a new event starts: a day on the device's clock and the minutes after its
// midnight.
export type FormStart = { date: CivilDate; minute: number };

// What the dialog's fields hold. Dates and times stay as the inputs wrote them, so a
// half-typed one waits for the person to finish it. They are on the device's clock.
export type EventForm = {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  // The day it ends. For an all-day event that's its last day, so a one-day event ends
  // on the day it starts.
  endDate: string;
  endTime: string;
  repeat: RepeatFrequency | "none";
  repeatEnd: RepeatEnd["kind"];
  repeatUntil: string;
  repeatTimes: string;
  location: string;
  notes: string;
  // The event's own time zone, which a repeat keeps to. A new event takes the device's.
  timeZone: TimeZone;
  // Who's invited, in the order they were added.
  people: Guest[];
};

export type Guest =
  | { kind: "colleague"; userId: UserId; name: string }
  | { kind: "outside"; email: EmailAddress };

export const guestName = (guest: Guest) =>
  guest.kind === "colleague" ? guest.name : guest.email;

const askedFor = (guest: Guest): PersonToInvite =>
  guest.kind === "colleague" ? guest.userId : { email: guest.email };

export const guestKey = (guest: Guest) => keyOfPerson(askedFor(guest));

export type FormField = keyof EventForm;

export type CheckedForm =
  | { ok: true; draft: EventDraft }
  | { ok: false; field: FormField; message: string };

// The calendar and event that a button on the card or panel acts on.
export type EventPlace = {
  calendarId: CalendarId;
  calendar: CalendarEntry;
  target: EventTarget;
};

export type EventAction =
  | { kind: "edit"; place: EventPlace }
  | { kind: "delete"; place: EventPlace }
  // Takes the event off its own calendar only.
  | { kind: "remove"; place: EventPlace };

export const SCOPE_LABELS: Record<ChangeScope, string> = {
  this: "Only this one",
  thisAndLater: "This and later ones",
  all: "All of them",
};

const pad = (value: number) => String(value).padStart(2, "0");

const clockOf = (wall: WallTime) => {
  const minute = Math.round((wall - wallOfDate(dateOfWall(wall))) / MINUTE_MS);
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
};

function minuteOfClock(text: string): number | null {
  const match = CLOCK.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function wallAt(date: string, time: string): WallTime | null {
  const day = parseCivilDate(date);
  const minute = minuteOfClock(time);
  if (!day || minute === null) return null;
  return (wallOfDate(day) + minute * MINUTE_MS) as WallTime;
}

const startAt = (wall: WallTime): FormStart => {
  const date = dateOfWall(wall);
  return { date, minute: Math.round((wall - wallOfDate(date)) / MINUTE_MS) };
};

export const slotStart = (date: CivilDate, minute: number): FormStart => ({
  date,
  minute:
    Math.min(Math.max(Math.floor(minute / SLOT_MINUTES), 0), SLOTS_IN_DAY - 1) *
    SLOT_MINUTES,
});

export function nextHalfHour(now: number, zone: TimeZone): FormStart {
  const slot = SLOT_MINUTES * MINUTE_MS;
  return startAt(
    ((Math.floor(wallOf(now, zone) / slot) + 1) * slot) as WallTime,
  );
}

const noRepeat = {
  repeat: "none",
  repeatEnd: "never",
  repeatUntil: "",
  repeatTimes: "10",
} as const;

export function newForm(start: FormStart, zone: TimeZone): EventForm {
  const from = (wallOfDate(start.date) + start.minute * MINUTE_MS) as WallTime;
  const to = (from + LENGTH_MINUTES * MINUTE_MS) as WallTime;
  return {
    title: "",
    allDay: false,
    startDate: start.date,
    startTime: clockOf(from),
    endDate: dateOfWall(to),
    endTime: clockOf(to),
    ...noRepeat,
    location: "",
    notes: "",
    timeZone: zone,
    people: [],
  };
}

function repeatFields(repeat: Occurrence["repeat"]) {
  if (!repeat || repeat.frequency === "custom") return noRepeat;
  const { end } = repeat;
  return {
    repeat: repeat.frequency,
    repeatEnd: end.kind,
    repeatUntil: end.kind === "onDate" ? end.date : "",
    repeatTimes: end.kind === "afterTimes" ? String(end.times) : "10",
  };
}

// The date of the event that was opened, with the series' repeat.
export function formOf(event: Occurrence, zone: TimeZone): EventForm {
  const { time } = event;
  const details = {
    title: event.title,
    ...repeatFields(event.repeat),
    location: event.location,
    notes: event.notes,
    people: event.people.map((person): Guest =>
      person.kind === "colleague"
        ? { kind: "colleague", userId: person.userId, name: person.name }
        : { kind: "outside", email: person.email },
    ),
  };
  if (time.kind === "allDay") {
    return {
      ...details,
      allDay: true,
      startDate: time.startDate,
      startTime: "09:00",
      endDate: addDays(time.endDate, -1),
      endTime: "10:00",
      timeZone: zone,
    };
  }
  const from = wallOf(time.start, zone);
  const to = wallOf(time.end, zone);
  return {
    ...details,
    allDay: false,
    startDate: dateOfWall(from),
    startTime: clockOf(from),
    endDate: dateOfWall(to),
    endTime: clockOf(to),
    timeZone: time.timeZone,
  };
}

// Moving the start keeps the event's length, so the end moves with it.
export function withStart(
  form: EventForm,
  change: Partial<Pick<EventForm, "startDate" | "startTime">>,
): EventForm {
  const next = { ...form, ...change };
  const before = wallAt(form.startDate, form.startTime);
  const end = wallAt(form.endDate, form.endTime);
  const after = wallAt(next.startDate, next.startTime);
  if (before === null || end === null || after === null) return next;
  const moved = (after + (end - before)) as WallTime;
  return { ...next, endDate: dateOfWall(moved), endTime: clockOf(moved) };
}

const problem = (field: FormField, message: string): CheckedForm => ({
  ok: false,
  field,
  message,
});

function timeOf(
  form: EventForm,
  zone: TimeZone,
): { time: EventTime } | CheckedForm {
  const startDate = parseCivilDate(form.startDate);
  if (!startDate) return problem("startDate", "Choose the day it starts.");
  const endDate = parseCivilDate(form.endDate);
  if (!endDate) return problem("endDate", "Choose the day it ends.");
  if (form.allDay) {
    if (endDate < startDate) {
      return problem("endDate", "The end is before the start.");
    }
    return {
      time: { kind: "allDay", startDate, endDate: addDays(endDate, 1) },
    };
  }
  const from = wallAt(startDate, form.startTime);
  if (from === null) return problem("startTime", "Choose when it starts.");
  const to = wallAt(endDate, form.endTime);
  if (to === null) return problem("endTime", "Choose when it ends.");
  const start = instantOf(from, zone);
  const end = instantOf(to, zone);
  if (end < start) {
    return problem(
      endDate === startDate ? "endTime" : "endDate",
      "The end is before the start.",
    );
  }
  if (end === start) {
    return problem("endTime", "The end is the same as the start.");
  }
  return { time: { kind: "timed", start, end, timeZone: form.timeZone } };
}

function repeatOf(
  form: EventForm,
  startDate: string,
): { repeat: Repeat | null } | CheckedForm {
  if (form.repeat === "none") return { repeat: null };
  const frequency = form.repeat;
  switch (form.repeatEnd) {
    case "never":
      return { repeat: { frequency, end: { kind: "never" } } };
    case "onDate": {
      const date = parseCivilDate(form.repeatUntil);
      if (!date) {
        return problem("repeatUntil", "Choose the day the repeat ends.");
      }
      if (date < startDate) {
        return problem(
          "repeatUntil",
          "The repeat ends before the event starts.",
        );
      }
      return { repeat: { frequency, end: { kind: "onDate", date } } };
    }
    case "afterTimes": {
      const times = /^\d+$/.test(form.repeatTimes.trim())
        ? Number(form.repeatTimes)
        : 0;
      if (times < 1 || times > MAX_REPEAT_TIMES) {
        return problem(
          "repeatTimes",
          `Choose a number from 1 to ${MAX_REPEAT_TIMES}.`,
        );
      }
      return { repeat: { frequency, end: { kind: "afterTimes", times } } };
    }
  }
}

// The answer to a repeat with no dates, at the field it's fixed in. It says what saving
// would do rather than what the form shows, since the two can differ.
export function askForEnd(
  needs: NoDatesLeft["needs"],
  today: CivilDate,
): { field: FormField; message: string } {
  const told = "The repeat would end up with no dates, so it wasn't saved.";
  return needs.kind === "onDate"
    ? {
        field: "repeatUntil",
        message: `${told} Set the last date to ${dayTitle(needs.date, today)} or later.`,
      }
    : {
        field: "repeatTimes",
        message: `${told} Set the number of times to ${needs.times} or more.`,
      };
}

// `zone` is the device's, which the fields are on.
export function draftOf(form: EventForm, zone: TimeZone): CheckedForm {
  const title = form.title.trim();
  if (title === "") return problem("title", "Add a title.");
  const timed = timeOf(form, zone);
  if (!("time" in timed)) return timed;
  const repeated = repeatOf(form, form.startDate);
  if (!("repeat" in repeated)) return repeated;
  return {
    ok: true,
    draft: {
      title,
      location: form.location.trim(),
      notes: form.notes,
      time: timed.time,
      repeat: repeated.repeat,
      people: form.people.map(askedFor),
    },
  };
}

const sameRepeat = (a: Occurrence["repeat"], b: Repeat | null) =>
  JSON.stringify(repeatFields(a)) === JSON.stringify(repeatFields(b));

const samePeople = (event: Occurrence, draft: EventDraft) => {
  const asked = new Set(draft.people.map(keyOfPerson));
  return (
    event.people.length === draft.people.length &&
    event.people.every((person) => asked.has(keyOfPerson(person)))
  );
};

// Null when there is nothing to ask, because the event doesn't repeat. "Only this one"
// leaves the repeat and the people as they were, so it isn't offered when either changed.
export function scopesFor(
  event: Occurrence,
  draft: EventDraft | null,
): ChangeScope[] | null {
  if (event.occurrenceId === null) return null;
  if (
    draft &&
    (!sameRepeat(event.repeat, draft.repeat) || !samePeople(event, draft))
  ) {
    return ["thisAndLater", "all"];
  }
  return ["this", "thisAndLater", "all"];
}

export const writableCalendars = (calendars: CalendarEntry[]) =>
  calendars.filter((entry) => levelOfRole(entry.role) === "edit");

const changing = (place: EventPlace): EventAction[] => [
  { kind: "edit", place },
  { kind: "delete", place },
];

type ShownOccurrence = CalendarOccurrence & { calendar: CalendarEntry };

// The event a colleague's copy follows, when the person can edit the calendar that
// holds it. A custom repeat can't be changed there either, and a called-off date is
// already gone from it.
function sourceOf(
  event: ShownOccurrence,
  calendars: CalendarEntry[],
): EventPlace | null {
  const { organiser } = event;
  if (
    organiser.kind !== "colleague" ||
    event.cancelled ||
    event.repeat?.frequency === "custom"
  ) {
    return null;
  }
  const calendar = writableCalendars(calendars).find(
    (entry) => entry.id === organiser.calendarId,
  );
  return calendar
    ? {
        calendarId: organiser.calendarId,
        calendar,
        target: { uid: organiser.uid, occurrenceId: event.occurrenceId },
      }
    : null;
}

// An invitation copy, or a repeat from outside, can't be changed, but whoever can edit
// its calendar can remove it. A copy's Edit and Delete change the event it follows, and
// the server checks access to that calendar again.
export function actionsFor(
  event: ShownOccurrence,
  calendars: CalendarEntry[],
): EventAction[] {
  const own: EventPlace = {
    calendarId: event.calendarId,
    calendar: event.calendar,
    target: { uid: event.uid, occurrenceId: event.occurrenceId },
  };
  if (event.changeable) return changing(own);
  const source = sourceOf(event, calendars);
  return [
    ...(source ? changing(source) : []),
    ...(levelOfRole(event.calendar.role) === "edit"
      ? [{ kind: "remove" as const, place: own }]
      : []),
  ];
}
