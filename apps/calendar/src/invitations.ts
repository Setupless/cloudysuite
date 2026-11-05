import type { CalendarId, UserId } from "@cloudysuite/access";
import type {
  Answer,
  Attendee,
  EventDetails,
  EventTime,
  EventUid,
  OccurrenceId,
} from "./types";

// One event, or one changed date of it, as the organiser's calendar holds it.
export type DeliveredPart = EventDetails & {
  recurrenceId: OccurrenceId | null;
  time: EventTime;
  rule: string | null;
  exdates: OccurrenceId[];
  sequence: number;
};

// What one Calendar object hands another person's calendar. It's read from the event as
// it is when it goes, so a retry carries the latest version, never an older one.
export type Delivery =
  | {
      kind: "event";
      uid: EventUid;
      from: CalendarId;
      // Whose personal calendar it's for, so the copy knows whose answer it holds.
      to: UserId;
      organiser: { userId: UserId; name: string | null };
      // The series, then its changed dates.
      parts: DeliveredPart[];
      people: Attendee[];
      // Grows with every change to who's invited or how they answered, so an older list
      // can't replace a newer one.
      peopleRevision: number;
    }
  // Gone from the organiser's calendar, or this person isn't invited any more.
  | { kind: "cancelled"; uid: EventUid; from: CalendarId; sequence: number };

export type DeliveryResult = "received" | "unchanged" | "refused";

// One person's answer, for the calendar that holds the event.
export type AnswerNotice = {
  uid: EventUid;
  calendarId: CalendarId;
  attendee: UserId;
  answer: Answer;
  // Grows with each answer this person gives, so a late older one changes nothing.
  revision: number;
};

// A queued delivery. The version grows each time the event changes again, so finishing
// an older send can't drop the newer one.
export type QueuedDelivery = {
  userId: UserId;
  uid: EventUid;
  calendarId: CalendarId;
  version: number;
};

const FIRST_RETRY_MS = 60_000;
const LONGEST_RETRY_MS = 60 * 60_000;

export const retryAt = (now: number, tries: number) =>
  now + Math.min(FIRST_RETRY_MS * 2 ** tries, LONGEST_RETRY_MS);
