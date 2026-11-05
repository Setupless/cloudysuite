import type {
  CalendarId,
  CalendarKind,
  CalendarRole,
  UserId,
} from "@cloudysuite/access";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

// An iCalendar UID. With an occurrence, it names one date of a repeat.
export type EventUid = Brand<string, "EventUid">;
// "2026-11-05". A day on the calendar, the same in every time zone.
export type CivilDate = Brand<string, "CivilDate">;
// An IANA name such as "Australia/Sydney", checked against the runtime's own list.
export type TimeZone = Brand<string, "TimeZone">;
// The original start of one date of a repeat, as its RECURRENCE-ID: "20261105T230000Z"
// for a timed event and "20261105" for an all-day one. A change to that date keeps it.
export type OccurrenceId = Brand<string, "OccurrenceId">;

export type EventTime =
  // UTC instants. The time zone keeps a repeat on the same local time across a
  // daylight-saving change.
  | { kind: "timed"; start: number; end: number; timeZone: TimeZone }
  // The end is the day after the last day, as iCalendar writes it.
  | { kind: "allDay"; startDate: CivilDate; endDate: CivilDate };

export const REPEAT_FREQUENCIES = [
  "daily",
  "weekdays",
  "weekly",
  "monthly",
  "yearly",
] as const;
export type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number];

export type RepeatEnd =
  | { kind: "never" }
  // The last day that can hold a date, in the event's own time zone.
  | { kind: "onDate"; date: CivilDate }
  | { kind: "afterTimes"; times: number };

// A repeat the event dialog can show and write.
export type Repeat = { frequency: RepeatFrequency; end: RepeatEnd };

// A rule from outside that the dialog can't show is kept exactly as written, and the
// event can then only be removed.
export type ShownRepeat = Repeat | { frequency: "custom" };

export type Organiser =
  // Made on this calendar. This copy is the one everyone follows, so anyone with Can
  // edit here may change it.
  | { kind: "madeHere"; userId: UserId }
  // A copy of an event organised somewhere else. It can be answered or removed.
  | { kind: "invitation"; email: string; name: string | null };

export type EventDetails = { title: string; location: string; notes: string };

// What the dialog sends. A change to one date ignores the repeat.
export type EventDraft = EventDetails & {
  time: EventTime;
  repeat: Repeat | null;
};

export type Occurrence = EventDetails & {
  uid: EventUid;
  // Null for an event that doesn't repeat.
  occurrenceId: OccurrenceId | null;
  time: EventTime;
  repeat: ShownRepeat | null;
  organiser: Organiser;
  // Decided by the same rule that refuses a change, so a button can match it.
  changeable: boolean;
};

// Whole days on the viewer's own calendar. `to` is the day after the last day shown.
export type DayRange = { from: CivilDate; to: CivilDate; timeZone: TimeZone };

export type RangeListing = {
  occurrences: Occurrence[];
  // False when the range held more than MAX_OCCURRENCES, or a series took too long to
  // work out, so some dates are missing.
  complete: boolean;
};

export const MAX_OCCURRENCES = 1000;

export type ChangeScope = "this" | "thisAndLater" | "all";

export type EventTarget = { uid: EventUid; occurrenceId: OccurrenceId | null };

export type CreateResult =
  { status: "created"; uid: EventUid } | { status: "noAccess" };

export type ChangeResult =
  | { status: "done" }
  // Can view, which can only look.
  | { status: "noAccess" }
  // Organised somewhere else, or a repeat from outside, which can only be removed.
  | { status: "readOnly" }
  | { status: "gone" };

export type EraseResult = { status: "done" } | { status: "noAccess" };

export type Person = { id: UserId; name: string; email: string };

export type CalendarEntry = {
  // Null until the personal calendar is first used. Looking changes nothing.
  id: CalendarId | null;
  kind: CalendarKind;
  // A personal calendar shows its person's own name.
  name: string;
  colour: number;
  role: CalendarRole;
  hidden: boolean;
};

export type CalendarOccurrence = Occurrence & { calendarId: CalendarId };

export type EventListing = {
  occurrences: CalendarOccurrence[];
  complete: boolean;
};

export type Member = { person: Person; role: CalendarRole };

export const NO_ACCESS_MESSAGE =
  "You don't have access to this calendar. Ask one of its managers if you need it.";
export const VIEW_ONLY_MESSAGE =
  "You can only view this calendar. Ask one of its managers if you need to change it.";
export const READ_ONLY_MESSAGE =
  "This event was set up somewhere else, so it can't be changed here. You can still remove it from your calendar.";
export const EVENT_GONE_MESSAGE =
  "This event isn't on the calendar any more. Someone may have changed or removed it.";
export const ONLY_MANAGERS_MESSAGE =
  "Only a manager of this calendar can do that.";
export const LAST_MANAGER_MESSAGE =
  "A team calendar needs at least one manager. Make someone else a manager first.";
export const NOT_ON_IT_MESSAGE = "That person isn't on this calendar.";
export const NOT_A_PERSON_MESSAGE =
  "One of those people can't be added. They may have been removed or suspended.";
