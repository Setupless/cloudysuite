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
  "fortnightly",
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
  // edit here may change it. The name is kept because removing a person deletes their
  // user row. It's null on events made before names were kept.
  | { kind: "madeHere"; userId: UserId; name: string | null }
  // A copy of an event a colleague organised on another calendar here, which an answer
  // goes straight to. It can be answered or removed. The copy has a UID of its own here,
  // and this is the calendar that holds the event and the event's UID there.
  | {
      kind: "colleague";
      userId: UserId;
      name: string | null;
      calendarId: CalendarId;
      uid: EventUid;
    }
  // A copy of an invitation emailed from outside. It can be answered, by an email to that
  // address, or removed. Only mail from that address that proves it was sent from there
  // can change it. The copy has a UID of its own here, from the organiser's address and
  // the UID they sent, which is this one. `fromOrganiser` says that proof came with it.
  | {
      kind: "outside";
      email: EmailAddress;
      name: string | null;
      uid: EventUid;
      fromOrganiser: boolean;
    };

export const ANSWERS = ["needsAnswer", "yes", "maybe", "no"] as const;
export type Answer = (typeof ANSWERS)[number];
export type GivenAnswer = Exclude<Answer, "needsAnswer">;
export const GIVEN_ANSWERS = [
  "yes",
  "maybe",
  "no",
] as const satisfies readonly GivenAnswer[];

// Lowercase and checked by parseEmailAddress, so one address is always one string.
export type EmailAddress = Brand<string, "EmailAddress">;

// Someone invited: a colleague from the directory, or anyone by email address.
export type Attendee =
  | { kind: "colleague"; userId: UserId; name: string; answer: Answer }
  // The name is the address until an answer from them says more.
  | { kind: "outside"; email: EmailAddress; name: string; answer: Answer };

// Names one person on an event's list, a colleague or an address, the same way however
// they were added. "user:…" or "mailto:…".
export type PersonKey = Brand<string, "PersonKey">;

// Someone the dialog asks to invite: a colleague's id, or an address.
export type PersonToInvite = UserId | { email: EmailAddress };

export const keyOfPerson = (person: Attendee | PersonToInvite): PersonKey =>
  (typeof person === "string"
    ? `user:${person}`
    : "kind" in person && person.kind === "colleague"
      ? `user:${person.userId}`
      : `mailto:${person.email}`) as PersonKey;

// Someone the directory says can be invited now, with the name it holds for them.
export type Invitee = { userId: UserId; name: string };

export type EventDetails = { title: string; location: string; notes: string };

// What the dialog sends. A change to one date ignores the repeat, and can't change who's
// invited, because every date of a repeat has the same people.
export type EventDraft = EventDetails & {
  time: EventTime;
  repeat: Repeat | null;
  people: PersonToInvite[];
};

// Why an invitation email didn't go. The checks run again before each attempt, and the
// rest are the mail service's own refusals.
export const NOT_SENT_REASONS = [
  "calendarOff",
  "mailOff",
  "changerCantEdit",
  "noSender",
  "checkUnavailable",
  "rateLimited",
  "senderNotVerified",
  "dailyLimit",
  "accountSuspended",
  "recipientNotAllowed",
  "recipientSuppressed",
  "deliveryRefused",
  "invalidMessage",
] as const;
export type NotSentReason = (typeof NOT_SENT_REASONS)[number];

// An invitation email to one person that didn't go, or that may not have.
export type NotSent =
  { kind: "refused"; reason: NotSentReason } | { kind: "unclear" };

// Someone an email about an event didn't reach, or may not have, by the name they had on
// its list when the email was due.
export type UnsentTo = { key: PersonKey; name: string; notSent: NotSent };

// The cancellation of an event that's been deleted, which didn't reach someone.
export type UnsentCancellation = {
  uid: EventUid;
  title: string;
  time: EventTime;
  to: UnsentTo;
};

// Whether people outside can be invited to an event, from its organiser's address.
export type OutsideInviting = "ready" | "mailOff" | "noSender";

export type Occurrence = EventDetails & {
  uid: EventUid;
  // Null for an event that doesn't repeat.
  occurrenceId: OccurrenceId | null;
  time: EventTime;
  repeat: ShownRepeat | null;
  organiser: Organiser;
  // Decided by the same rule that refuses a change, so a button can match it.
  changeable: boolean;
  // Everyone invited, in the order they were added. Only the organiser's calendar knows
  // which emails didn't go, so a copy says null for everyone.
  people: (Attendee & { notSent: NotSent | null })[];
  // Taken off the list, while the email telling them it's off didn't go.
  takenOff: UnsentTo[];
  // The viewer's own answer, on a copy of an invitation sent to them, and null otherwise.
  answer: Answer | null;
  // The organiser called off this date, or the whole event.
  cancelled: boolean;
  // The meeting link an invitation from outside gave, as hostile as its other text.
  conference: string | null;
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

export const MAX_TITLE_LENGTH = 500;
export const MAX_LOCATION_LENGTH = 1000;
export const MAX_NOTES_LENGTH = 10_000;
export const MAX_REPEAT_TIMES = 999;
// A name kept on an event, the organiser's or an invited person's.
export const MAX_PERSON_NAME_LENGTH = 100;
export const MAX_INVITED = 100;

export type ChangeScope = "this" | "thisAndLater" | "all";

export type EventTarget = { uid: EventUid; occurrenceId: OccurrenceId | null };

// A new address on the list needs an email from the organiser's address, so neither Mail
// being off nor an organiser with no personal mailbox can let one on.
export type OutsideRefused = {
  status: "outsideNotAllowed";
  why: Exclude<OutsideInviting, "ready">;
};

// `first` is the event's first date, which a repeat can put after the start, as every
// weekday does from a Saturday.
export type CreatedEvent = { uid: EventUid; first: EventTime };

// A repeat with no date left, because none falls between its start and its end or the
// ones that do were removed on their own. Going on with no end, it would first happen on
// `firstDay`, where the event is.
export type NeverHappens = { status: "neverHappens"; firstDay: CivilDate };

export type CreateResult =
  | ({ status: "created" } & CreatedEvent)
  | { status: "noAccess" }
  // Someone asked for can't be invited, because they were removed or suspended.
  | { status: "notInvitable" }
  | NeverHappens
  | OutsideRefused;

export type ChangeResult =
  | { status: "done" }
  // Can view, which can only look.
  | { status: "noAccess" }
  // Organised somewhere else, or a repeat from outside, which can only be removed.
  | { status: "readOnly" }
  | { status: "gone" }
  | { status: "notInvitable" }
  // Who's invited changes from a date onwards, or for every date, never for one.
  | { status: "peopleForOneDate" }
  | NeverHappens
  | OutsideRefused;

// Try again on an email that didn't go. Done also covers one already on its way again.
export type RetryResult =
  { status: "done" } | { status: "noAccess" } | { status: "gone" };

// Gone also covers a copy that isn't this person's to answer.
export type AnswerResult = { status: "done" } | { status: "gone" };

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

// A repeat is found once, at its next date, or at its last date once it has ended.
export type EventSearchResult = {
  occurrences: Occurrence[];
  // Whether more matched than are here.
  more: boolean;
  // False when the repeats took too long to work out, so some may be missing.
  complete: boolean;
};

export type EventSearchAnswer =
  | {
      status: "found";
      occurrences: CalendarOccurrence[];
      more: boolean;
      // Whether some calendar couldn't answer.
      incomplete: boolean;
    }
  | { status: "problem"; problem: string };

export type Member = { person: Person; role: CalendarRole };

export const MAX_UID_LENGTH = 255;

// One import is one request, and a file at both limits took under 2 seconds on the
// Workers runtime.
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_IMPORT_EVENTS = 10_000;

// A calendar part of an email is read on Mail's alarm, from anyone, so it gets a
// sixteenth of a file's size. An invitation is one event and its changed dates.
export const MAX_INVITATION_PART_BYTES = 256 * 1024;
export const MAX_INVITATION_PARTS = 3;
export const MAX_INVITATION_EVENTS = 200;
// Each event an email adds, changes, or answers costs a call to a calendar from Mail's
// alarm. A real invitation is one, with its changed dates, so the rest are left.
export const MAX_EVENTS_PER_EMAIL = 20;

export const SKIP_REASONS = [
  "unreadable",
  "tooComplex",
  "noId",
  "noStart",
  "outOfRange",
  "endsBeforeStart",
  "neverHappens",
  "cancelled",
  "noSeries",
] as const;
// Why one event in a file wasn't imported.
export type SkipReason = (typeof SKIP_REASONS)[number];

// What Calendar can't show of the dates an event from outside gives. "firstDateOnly" is
// a rule it can't follow. "mainRepeatOnly" is a rule it follows, beside extra dates or
// rules that it doesn't keep.
export type Shortfall = "firstDateOnly" | "mainRepeatOnly";

// Each event counts once, however many dates it has or how many of them were changed.
export type ImportSummary = {
  added: number;
  updated: number;
  // Already up to date, or removed here before.
  unchanged: number;
  // Held here as an invitation from its organiser, which import can't change.
  organisedElsewhere: number;
  // Added or updated with that shortfall.
  firstDateOnly: number;
  mainRepeatOnly: number;
  skipped: Partial<Record<SkipReason, number>>;
};

export const SKIP_REASON_TEXT: Record<
  SkipReason,
  { one: string; many: string }
> = {
  unreadable: { one: "couldn't be read", many: "couldn't be read" },
  tooComplex: {
    one: "has details too long or complicated to read",
    many: "have details too long or complicated to read",
  },
  noId: {
    one: "is missing the ID that tells events apart",
    many: "are missing the ID that tells events apart",
  },
  noStart: { one: "has no start date", many: "have no start date" },
  outOfRange: {
    one: "is dated before 1900 or after 2199",
    many: "are dated before 1900 or after 2199",
  },
  endsBeforeStart: {
    one: "ends before it starts",
    many: "end before they start",
  },
  neverHappens: {
    one: "repeats on no dates at all",
    many: "repeat on no dates at all",
  },
  cancelled: { one: "was cancelled", many: "were cancelled" },
  noSeries: {
    one: "changes one date of a repeating event that isn't in the file",
    many: "change one date of a repeating event that isn't in the file",
  },
};

export const IMPORT_TOO_LARGE_MESSAGE =
  "This file is larger than 4 MB, so Calendar can't import it. Export fewer events, such as one calendar or a shorter time, and import that file.";
export const IMPORT_TOO_MANY_MESSAGE =
  "This file has more than 10,000 events, which is more than Calendar can import at once. Export fewer events, such as one calendar or a shorter time, and import that file.";
export const IMPORT_NOT_CALENDAR_MESSAGE =
  "This isn't a calendar file Calendar can read. Choose a .ics file exported from a calendar app.";

export const NO_ACCESS_MESSAGE =
  "You don't have access to this calendar. Ask one of its managers if you need it.";
export const VIEW_ONLY_MESSAGE =
  "You can only view this calendar. Ask one of its managers if you need to change it.";
export const READ_ONLY_MESSAGE =
  "This event was set up somewhere else, so it can't be changed here. You can still remove it from your calendar.";
export const NEVER_HAPPENS_MESSAGE =
  "This repeat would never happen, so it wasn't saved.";
// The day is the first it would happen on, so going on until then always works.
export const neverHappensMessage = (day: string) =>
  `${NEVER_HAPPENS_MESSAGE} Make it go on until at least ${day}.`;
export const EVENT_GONE_MESSAGE =
  "This event isn't on the calendar any more. Someone may have changed or removed it.";
export const ONLY_MANAGERS_MESSAGE =
  "Only a manager of this calendar can do that.";
export const LAST_MANAGER_MESSAGE =
  "A team calendar needs at least one manager. Make someone else a manager first.";
export const NOT_ON_IT_MESSAGE = "That person isn't on this calendar.";
export const PEOPLE_FOR_ONE_DATE_MESSAGE =
  "Who's invited can't change for only one date. Choose This and later ones, or All of them.";
export const NOT_A_PERSON_MESSAGE =
  "One of those people can't be added. They may have been removed or suspended.";
export const PERSONAL_CALENDAR_MESSAGE =
  "Your own calendar is just for you. It can't be deleted or left, and nobody else can be added to it.";
export const NOT_AN_ADDRESS_MESSAGE =
  "One of the email addresses isn't complete. Check it, such as name@example.com.";
export const OUTSIDE_REFUSED_MESSAGES: Record<OutsideRefused["why"], string> = {
  mailOff:
    "Mail is off, so people outside your organisation can't be invited. Invite colleagues only, or ask your admin to turn Mail back on.",
  noSender:
    "Invitations to people outside your organisation go from the organiser's own mailbox, and this organiser doesn't have one. Invite colleagues only, or ask your admin for a mailbox.",
};
