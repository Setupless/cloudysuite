import type { CalendarId, UserId } from "@cloudysuite/access";
import type {
  Answer,
  Attendee,
  EventDetails,
  EventTime,
  EventUid,
  OccurrenceId,
  PersonKey,
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

// A queued invitation email to one person. The version grows each time the event
// changes again, so settling an older send can't settle the newer one.
export type QueuedEmail = {
  uid: EventUid;
  recipient: PersonKey;
  calendarId: CalendarId;
  // Who made the latest change, or chose Try again, who must still be able to edit.
  changedBy: UserId;
  version: number;
  // Sending is a claim from a run that never finished.
  state: "queued" | "sending";
  // Rate limits met so far.
  tries: number;
  // What the last email that went, or may have gone, said.
  sent: EmailMethod | null;
};

// iTIP's REQUEST, for an invitation or an update, and CANCEL.
export type EmailMethod = "request" | "cancel";

// One date as they last saw it, at the series' sequence for the change that called it off.
export type CancelledDate = DeliveredPart & { recurrenceId: OccurrenceId };

// Whether the person still has the event once this email reaches them, which is what the
// queue keeps as sent. A cancelled date leaves them the rest of the series.
export const heldAfter = (
  plan: Exclude<EmailPlan, { method: "none" }>,
): EmailMethod =>
  plan.method === "cancel" && plan.why !== "dateCancelled"
    ? "cancel"
    : "request";

export type EmailPlanOrganiser = { userId: UserId; name: string | null };

// The event was deleted, or its whole team calendar was.
export type Gone = "deleted" | "calendarDeleted";

// What one queued email says, read from the event as it is when it goes.
export type EmailPlan =
  | {
      method: "request";
      uid: EventUid;
      organiser: EmailPlanOrganiser;
      // The series, then its changed dates.
      parts: DeliveredPart[];
      people: Attendee[];
      to: Attendee;
      // Nothing reached them before, or the last thing was a cancellation.
      first: boolean;
    }
  | {
      method: "cancel";
      uid: EventUid;
      organiser: EmailPlanOrganiser;
      // At a sequence above any that went before.
      series: DeliveredPart;
      to: PersonKey;
      why: "uninvited" | Gone;
    }
  // One date of a series they still have, as RFC 5546 cancels a single instance.
  | {
      method: "cancel";
      uid: EventUid;
      organiser: EmailPlanOrganiser;
      series: DeliveredPart;
      date: CancelledDate;
      to: PersonKey;
      why: "dateCancelled";
    }
  // Nothing to say, as to someone taken off before anything reached them.
  | { method: "none" };

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
