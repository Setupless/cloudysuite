import { env } from "cloudflare:workers";
import type { UserId } from "@cloudysuite/access";
import { isAppOff } from "../../../src/app-on";
import { openCalendarAs } from "./access";
import type { CalendarClient } from "./client";
import {
  editableTeams,
  findPersonalCalendar,
  makePersonalCalendar,
} from "./directory";
import { parseEmailAddress } from "./email-address";
import { colleaguesAt, outsideInviting } from "./email/senders";
import {
  eventsOf,
  GIVEN,
  invitationFor,
  isReply,
  partOf,
  peopleOf,
  type Person,
  type Taken,
} from "./inbound";
import {
  type CopyLookup,
  type CopyStanding,
  copyUidOf,
  type HeldAnswer,
  type HeldCopy,
  type MailAddResult,
} from "./invitations";
import type { OutsideEvent, OutsidePerson } from "./outside/ics";
import { repeatOf } from "./repeat";
import {
  type Answer,
  type Attendee,
  EVENT_GONE_MESSAGE,
  type EventTime,
  type GivenAnswer,
  MAX_PERSON_NAME_LENGTH,
  type Organiser,
  type ShownRepeat,
} from "./types";
import { type MeetingLink, meetingLink } from "./ui/meeting-link";
import { refusal } from "./wire";

// The card in Mail's reading pane, for a message that carries calendar parts. Mail's
// server functions call these once Mail is on and the person can open the mailbox, and
// each checks that Calendar is on before it reads or changes anyone's calendar. The card
// reads the person's own calendar, whichever mailbox the message is in.

export type MailWithCalendar = {
  // The From address, which anyone can write.
  from: string | null;
  // Mail's sender check when the message arrived.
  proved: boolean;
  // Each calendar part's text, at most MAX_INVITATION_PARTS of MAX_INVITATION_PART_BYTES.
  parts: string[];
};

// One event as the card shows it: from the person's calendar while it holds the event,
// and from the email otherwise. Plain text, as hostile as message content.
export type CardEvent = {
  title: string;
  location: string;
  time: EventTime;
  repeat: ShownRepeat | null;
  organiser: string | null;
  join: MeetingLink | null;
};

// The calendar's version against the email's. Earlier means the email's change didn't
// count, and `confirmed` says whether the sender check passed for the organiser.
export type Version = "later" | "same" | "earlier";

type CalendarOff = { kind: "calendarOff" };

export type InvitationStanding =
  | CalendarOff
  | {
      kind: "held";
      // Null when it isn't this person's to answer.
      answer: Answer | null;
      cancelled: boolean;
      version: Version;
      confirmed: boolean;
      // Whether an answer reaches the organiser. One outside hears by email, from the
      // person's own mailbox.
      organiserTold: boolean;
    }
  | { kind: "removed" | "notHeld"; addable: boolean };

export type CancellationStanding =
  | CalendarOff
  // `cancelled` says the calendar marks what the email calls off as cancelled.
  | { kind: "held"; cancelled: boolean; version: Version; confirmed: boolean }
  | { kind: "notHeld" };

export type ReplyStanding =
  | CalendarOff
  // From someone other than who it answers for, or the sender check didn't pass.
  | { kind: "notConfirmed" }
  // None of the person's calendars where they can change events holds it.
  | { kind: "noEvent" }
  // The answer the event holds for them now.
  | { kind: "held"; answer: Answer };

// `someDates` is an email that changes or calls off only some dates of a repeat.
export type InvitationCard =
  | {
      kind: "invitation";
      event: CardEvent;
      someDates: boolean;
      standing: InvitationStanding;
    }
  | {
      kind: "cancellation";
      event: CardEvent;
      someDates: boolean;
      standing: CancellationStanding;
    }
  | {
      kind: "reply";
      event: CardEvent;
      who: string;
      answer: GivenAnswer;
      standing: ReplyStanding;
    };

const CALENDAR_OFF_MESSAGE =
  "An admin turned Calendar off, so invitations can't be answered or added from Mail. Nothing was changed. Ask your admin to turn Calendar back on.";
const NOTHING_TO_ADD_MESSAGE =
  "This email doesn't hold an event that can be added. It may cancel the event, or change only one date of it.";
const FROM_COLLEAGUE_MESSAGE =
  "This invitation is from a colleague, so it reaches your calendar from theirs. If you removed it, it can come back from here. Otherwise ask them to invite you again.";
const CANCELLED_MESSAGE =
  "This event was cancelled, so there's nothing to answer.";

const personName = (name: string | null, email: string) =>
  (name ?? email).slice(0, MAX_PERSON_NAME_LENGTH);

function organiserName(organiser: Organiser): string | null {
  if (organiser.kind === "outside") {
    return personName(organiser.name, organiser.email);
  }
  return organiser.name?.slice(0, MAX_PERSON_NAME_LENGTH) ?? null;
}

const repeatOfRule = (rule: string | null, time: EventTime) =>
  rule === null ? null : repeatOf(rule, time);

const fromEmail = (event: OutsideEvent, cancelled: boolean): CardEvent => ({
  title: event.title,
  location: event.location,
  time: event.time,
  repeat: repeatOfRule(event.rule, event.time),
  organiser: event.organiser
    ? personName(event.organiser.name, event.organiser.email)
    : null,
  join: meetingLink({ ...event, cancelled }),
});

const fromCalendar = (copy: HeldCopy): CardEvent => ({
  title: copy.title,
  location: copy.location,
  time: copy.time,
  repeat: repeatOfRule(copy.rule, copy.time),
  organiser: organiserName(copy.organiser),
  join: meetingLink(copy),
});

// The first event the email carries, which is all a real invitation holds.
const firstEvent = (mail: MailWithCalendar) => eventsOf(mail.parts)[0] ?? null;

type Invitation = {
  taken: Taken<"request" | "cancel">;
  // The series, or the first changed date when the email changes only some.
  event: OutsideEvent;
  organiser: OutsidePerson;
};

function invitationOf(mail: MailWithCalendar): Invitation | null {
  const first = firstEvent(mail);
  if (!first || isReply(first)) return null;
  const taken = first as Taken<"request" | "cancel">;
  const event = taken.group.series ?? taken.group.changes[0];
  const organiser = event?.organiser;
  return event && organiser ? { taken, event, organiser } : null;
}

async function lookupOf(invitation: Invitation): Promise<CopyLookup> {
  const { organiser, taken } = invitation;
  const colleague = (await colleaguesAt(env.DB, [organiser.email])).get(
    organiser.email,
  );
  return colleague
    ? { kind: "colleague", organiser: colleague, uid: taken.group.uid }
    : {
        kind: "outside",
        uid: await copyUidOf(organiser.email, taken.group.uid),
      };
}

// Looking changes nothing, so a person who hasn't used Calendar yet has no calendar to
// read, and holds nothing.
async function ownCalendar(userId: UserId): Promise<CalendarClient | null> {
  const calendarId = await findPersonalCalendar(env.DB, userId);
  return calendarId ? openCalendarAs(userId, calendarId) : null;
}

async function standingOf(userId: UserId, invitation: Invitation) {
  const [calendar, lookup] = await Promise.all([
    ownCalendar(userId),
    lookupOf(invitation),
  ]);
  const standing: CopyStanding = calendar
    ? await calendar.copyStanding(lookup)
    : { kind: "none" };
  return { calendar, lookup, standing };
}

function versionOf(copy: HeldCopy, taken: Invitation["taken"]): Version {
  const sent = Math.max(
    ...[taken.group.series, ...taken.group.changes].flatMap((part) =>
      part ? [part.sequence] : [],
    ),
  );
  return copy.sequence > sent
    ? "later"
    : copy.sequence === sent
      ? "same"
      : "earlier";
}

const sentBy = (mail: MailWithCalendar) => ({
  from: parseEmailAddress(mail.from),
  proved: mail.proved,
});

const confirmedFor = (mail: MailWithCalendar, organiser: OutsidePerson) =>
  mail.proved && parseEmailAddress(mail.from) === organiser.email;

const calendarOff = () => isAppOff(env.DB, "calendar");

async function requireCalendarOn(): Promise<void> {
  if (await calendarOff()) throw refusal(403, CALENDAR_OFF_MESSAGE);
}

export async function readInvitationCard(
  person: Person,
  mail: MailWithCalendar,
): Promise<InvitationCard | null> {
  const taken = firstEvent(mail);
  if (!taken) return null;
  if (isReply(taken)) return replyCard(person, mail, taken);
  const invitation = invitationOf(mail);
  if (!invitation) return null;
  return taken.method === "cancel" || invitation.event.cancelled
    ? cancellationCard(person, mail, invitation)
    : invitationCard(person, mail, invitation);
}

async function invitationCard(
  person: Person,
  mail: MailWithCalendar,
  invitation: Invitation,
): Promise<InvitationCard> {
  const { taken, event } = invitation;
  const someDates = taken.group.series === null;
  const card = (
    standing: InvitationStanding,
    shown = fromEmail(event, false),
  ) => ({ kind: "invitation", event: shown, someDates, standing }) as const;
  if (await calendarOff()) return card({ kind: "calendarOff" });

  const { lookup, standing } = await standingOf(person.id, invitation);
  if (standing.kind === "held") {
    const { copy } = standing;
    const answerable = copy.answer !== null && !copy.cancelled;
    return card(
      {
        kind: "held",
        answer: copy.answer,
        cancelled: copy.cancelled,
        version: versionOf(copy, taken),
        confirmed: confirmedFor(mail, invitation.organiser),
        organiserTold:
          !answerable ||
          copy.organiser.kind !== "outside" ||
          (await outsideInviting(env.DB, person.id)) === "ready",
      },
      // A changed date shows as the email gives it, since the series isn't what changed.
      someDates ? fromEmail(event, false) : fromCalendar(copy),
    );
  }
  // A colleague's copy comes back only from the calendar its removal names.
  const removedColleague =
    standing.kind === "removed" && standing.organiser?.kind === "colleague";
  return card({
    kind: standing.kind === "removed" ? "removed" : "notHeld",
    addable: !someDates && (lookup.kind === "outside" || removedColleague),
  });
}

async function cancellationCard(
  person: Person,
  mail: MailWithCalendar,
  invitation: Invitation,
): Promise<InvitationCard> {
  const { taken, event } = invitation;
  const someDates = taken.group.series === null;
  const shown = fromEmail(event, true);
  const card = (standing: CancellationStanding) =>
    ({ kind: "cancellation", event: shown, someDates, standing }) as const;
  if (await calendarOff()) return card({ kind: "calendarOff" });

  const { standing } = await standingOf(person.id, invitation);
  if (standing.kind !== "held") return card({ kind: "notHeld" });
  const { copy } = standing;
  return card({
    kind: "held",
    cancelled: someDates
      ? taken.group.changes.every(
          (change) =>
            change.recurrenceId !== null &&
            copy.calledOff.includes(change.recurrenceId),
        )
      : copy.cancelled,
    version: versionOf(copy, taken),
    confirmed: confirmedFor(mail, invitation.organiser),
  });
}

// As search asks calendars.
const CALENDARS_AT_ONCE = 5;

// A reply is found where Mail's hand-off looks for it: the person's own calendar, then
// the team calendars where they can change events.
async function replyCard(
  person: Person,
  mail: MailWithCalendar,
  taken: Taken<"reply">,
): Promise<InvitationCard | null> {
  const { series } = taken.group;
  const from = parseEmailAddress(mail.from);
  const attendee =
    series?.attendees.find((one) => one.email === from) ?? series?.attendees[0];
  const answer = attendee && GIVEN[attendee.answer];
  if (!series || !attendee || !answer) return null;
  // The organiser reads replies, so it names no organiser, and nobody joins from one.
  const card = (
    standing: ReplyStanding,
    { title, location, time, rule }: HeldAnswer["event"] = series,
  ) =>
    ({
      kind: "reply",
      event: {
        title,
        location,
        time,
        repeat: repeatOfRule(rule, time),
        organiser: null,
        join: null,
      },
      who: personName(attendee.name, attendee.email),
      answer,
      standing,
    }) as const;
  if (await calendarOff()) return card({ kind: "calendarOff" });
  if (!mail.proved || attendee.email !== from) {
    return card({ kind: "notConfirmed" });
  }

  const personal = await findPersonalCalendar(env.DB, person.id);
  const teams = await editableTeams(env.DB, person.id);
  const calendars = [...(personal ? [personal] : []), ...teams];
  for (let first = 0; first < calendars.length; first += CALENDARS_AT_ONCE) {
    const found = await Promise.all(
      calendars
        .slice(first, first + CALENDARS_AT_ONCE)
        .map(async (id) =>
          (await openCalendarAs(person.id, id)).outsideAnswer(
            taken.group.uid,
            attendee.email,
          ),
        ),
    );
    const held = found.find((one) => one !== null);
    if (held) return card({ kind: "held", answer: held.answer }, held.event);
  }
  return card({ kind: "noEvent" });
}

async function heldCopyFor(
  userId: UserId,
  mail: MailWithCalendar,
): Promise<{ calendar: CalendarClient; copy: HeldCopy } | null> {
  const invitation = invitationOf(mail);
  if (!invitation) return null;
  const { calendar, standing } = await standingOf(userId, invitation);
  return calendar && standing.kind === "held"
    ? { calendar, copy: standing.copy }
    : null;
}

// The same answer as Calendar's own buttons, so an organiser outside hears by email and
// one inside straight away.
export async function answerFromMail(
  person: Person,
  mail: MailWithCalendar,
  answer: GivenAnswer,
): Promise<void> {
  await requireCalendarOn();
  const held = await heldCopyFor(person.id, mail);
  if (!held || held.copy.answer === null) {
    throw refusal(404, EVENT_GONE_MESSAGE);
  }
  if (held.copy.cancelled) throw refusal(409, CANCELLED_MESSAGE);
  const result = await held.calendar.answer(held.copy.uid, answer);
  if (result.status === "gone") throw refusal(404, EVENT_GONE_MESSAGE);
}

// Safe to repeat: once it's gone, there's nothing left to remove.
export async function removeFromMail(
  person: Person,
  mail: MailWithCalendar,
): Promise<void> {
  await requireCalendarOn();
  const held = await heldCopyFor(person.id, mail);
  if (!held) return;
  await held.calendar.remove({ uid: held.copy.uid, occurrenceId: null }, "all");
}

function answerAdd(result: MailAddResult): void {
  switch (result) {
    case "added":
    case "held":
      return;
    case "nothing":
      throw refusal(409, NOTHING_TO_ADD_MESSAGE);
    case "noAccess":
      throw refusal(403, EVENT_GONE_MESSAGE);
  }
}

// Into the person's own calendar, whichever mailbox the email is in, since they chose it.
// Safe to repeat, since an event already there stays as it is.
export async function addFromMail(
  person: Person,
  mail: MailWithCalendar,
): Promise<void> {
  await requireCalendarOn();
  const invitation = invitationOf(mail);
  if (!invitation || invitation.taken.method !== "request") {
    throw refusal(409, NOTHING_TO_ADD_MESSAGE);
  }
  const { taken, event, organiser } = invitation;
  const [lookup, colleagues] = await Promise.all([
    lookupOf(invitation),
    colleaguesAt(
      env.DB,
      event.attendees.map((one) => one.email),
    ),
  ]);

  // The calendar object leaves a copy that's already there as it is, answer and all.
  if (lookup.kind === "outside") {
    const calendarId = await makePersonalCalendar(env.DB, person.id);
    if (!calendarId) throw refusal(403, EVENT_GONE_MESSAGE);
    const own = await openCalendarAs(person.id, calendarId);
    answerAdd(
      await own.addFromCard({
        kind: "outside",
        invitation: invitationFor(
          taken,
          organiser,
          person,
          colleagues,
          sentBy(mail),
        ),
      }),
    );
    return;
  }

  // A colleague's copy follows the calendar it came from, which only its removal names.
  const calendar = await ownCalendar(person.id);
  const standing = calendar && (await calendar.copyStanding(lookup));
  if (standing?.kind === "held") return;
  const source = standing?.kind === "removed" ? standing.organiser : null;
  if (!calendar || source?.kind !== "colleague") {
    throw refusal(409, FROM_COLLEAGUE_MESSAGE);
  }
  const parts = [taken.group.series, ...taken.group.changes].flatMap((part) =>
    part && !part.cancelled ? [partOf(part)] : [],
  );
  answerAdd(
    await calendar.addFromCard({
      kind: "colleague",
      delivery: {
        kind: "event",
        uid: source.uid,
        from: source.calendarId,
        to: person.id,
        organiser: { userId: source.userId, name: source.name },
        parts,
        // Added unanswered, as any invitation arrives.
        people: peopleOf(
          event.attendees,
          organiser.email,
          colleagues,
          person,
        ).map((one): Attendee =>
          one.kind === "colleague" && one.userId === person.id
            ? { ...one, answer: "needsAnswer" }
            : one,
        ),
        peopleRevision: 0,
      },
    }),
  );
}
