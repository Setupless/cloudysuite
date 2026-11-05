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

// Where a copy lives in the calendar it's sent to. Anyone can import a file with any UID,
// so two calendars can each send one with the same UID, and a copy is named by both. One
// calendar's copy can then never take the place of another's.
export async function copyUidOf(
  from: CalendarId,
  uid: EventUid,
): Promise<EventUid> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${from} ${uid}`),
  );
  return Array.from(new Uint8Array(digest).subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("") as EventUid;
}

const FIRST_RETRY_MS = 60_000;
const LONGEST_RETRY_MS = 60 * 60_000;

export const retryAt = (now: number, tries: number) =>
  now + Math.min(FIRST_RETRY_MS * 2 ** tries, LONGEST_RETRY_MS);
