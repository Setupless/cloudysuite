import type { CalendarId, MailboxId, UserId } from "@cloudysuite/access";
import { isAppOff } from "../../../src/app-on";
import { mailReceiver } from "./client";
import {
  editableTeams,
  findPersonalCalendar,
  makePersonalCalendar,
} from "./directory";
import { parseEmailAddress } from "./email-address";
import { colleaguesAt, personOfMailbox } from "./email/senders";
import type {
  OutsideInvitation,
  OutsidePart,
  OutsideReply,
} from "./invitations";
import {
  type CalendarMethod,
  type Attendee as InvitedPerson,
  type OutsideEvent,
  readCalendarFile,
} from "./outside/ics";
import { type EventGroup, groupByEvent } from "./store";
import { parseTimeZone } from "./time";
import {
  type Answer,
  type Attendee,
  type EmailAddress,
  type GivenAnswer,
  keyOfPerson,
  MAX_INVITATION_EVENTS,
  MAX_INVITATION_PART_BYTES,
  MAX_INVITATION_PARTS,
  MAX_PERSON_NAME_LENGTH,
  type TimeZone,
} from "./types";

export { MAX_INVITATION_PART_BYTES, MAX_INVITATION_PARTS };

// One inbound message with calendar parts, as Mail hands it over. Mail hands over only
// mail that landed outside Spam, never imported or sent mail.
export type CalendarMail = {
  mailboxId: MailboxId;
  // The From address, which anyone can write.
  from: string | null;
  // Mail's sender check passed for that address: DMARC, or DKIM for its domain or a
  // parent of it. The spam filter makes the same check.
  proved: boolean;
  // Each calendar part's text, at most MAX_INVITATION_PARTS of MAX_INVITATION_PART_BYTES.
  parts: string[];
};

const LIMITS = {
  bytes: MAX_INVITATION_PART_BYTES,
  events: MAX_INVITATION_EVENTS,
};
// As search asks calendars, and the first that holds the event ends the search.
const CALENDARS_AT_ONCE = 5;
// The organiser's clock for a time an invitation gives without a zone isn't known.
const UTC = parseTimeZone("UTC") as TimeZone;

const ANSWERS: Record<InvitedPerson["answer"], Answer> = {
  accepted: "yes",
  tentative: "maybe",
  declined: "no",
  needsAction: "needsAnswer",
};

// The one way Mail reaches Calendar, from Mail's alarm. Mail stored the message before
// this runs, so nothing here can lose or hold up mail. A throw asks Mail to try again
// later, which changes nothing twice, because UID and sequence decide.
export async function receiveCalendarMail(
  env: Env,
  mail: CalendarMail,
): Promise<void> {
  if (await isAppOff(env.DB, "calendar")) return;
  const person = await personOfMailbox(env.DB, mail.mailboxId);
  if (!person) return;
  const from = parseEmailAddress(mail.from);
  for (const text of new Set(mail.parts)) {
    const reading = readCalendarFile(text, UTC, LIMITS);
    if (reading.status !== "read" || !reading.method) continue;
    const { method, events } = reading;
    if (method === "reply") {
      if (from && mail.proved) await takeReplies(env, person, from, events);
      continue;
    }
    for (const group of groupByEvent(events)) {
      await takeInvitation(env, person, method, group, {
        from,
        proved: mail.proved,
      });
    }
  }
}

const partOf = (event: OutsideEvent): OutsidePart => ({
  recurrenceId: event.recurrenceId,
  title: event.title,
  location: event.location,
  notes: event.notes,
  time: event.time,
  rule: event.rule,
  exdates: event.exdates,
  sequence: event.sequence,
  conference: event.conference,
  cancelled: event.cancelled,
});

// The person whose calendar it is shows as themselves, so their answer is on the list.
// Google lists the organiser as a guest too, and People already names them.
function peopleOf(
  invited: InvitedPerson[],
  organiser: EmailAddress,
  colleagues: Map<EmailAddress, UserId>,
  person: UserId,
): Attendee[] {
  const people = invited.flatMap((one): Attendee[] => {
    if (one.email === organiser) return [];
    const name = (one.name ?? one.email).slice(0, MAX_PERSON_NAME_LENGTH);
    const answer = ANSWERS[one.answer];
    return [
      colleagues.get(one.email) === person
        ? { kind: "colleague", userId: person, name, answer }
        : { kind: "outside", email: one.email, name, answer },
    ];
  });
  // Their own address and an alias of it are still one person.
  const seen = new Set<string>();
  return people.filter((one) => {
    const key = keyOfPerson(one);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function takeInvitation(
  env: Env,
  person: UserId,
  method: Exclude<CalendarMethod, "reply">,
  group: EventGroup,
  sender: { from: EmailAddress | null; proved: boolean },
): Promise<void> {
  const shown = group.series ?? group.changes[0];
  const organiser = shown?.organiser;
  if (!shown || !organiser) return;
  const colleagues = await colleaguesAt(env.DB, [
    organiser.email,
    ...shown.attendees.map((one) => one.email),
  ]);
  // A colleague's invitation reaches the calendar straight from theirs, under a UID of
  // its own, and its email adds nothing beside it.
  if (colleagues.has(organiser.email)) return;
  // The first invitation that reaches someone makes their calendar. Nothing else does.
  const calendarId =
    method === "request"
      ? await makePersonalCalendar(env.DB, person)
      : await findPersonalCalendar(env.DB, person);
  if (!calendarId) return;
  const invitation: OutsideInvitation = {
    method,
    to: person,
    uid: group.uid,
    organiser,
    series: group.series && partOf(group.series),
    changes: group.changes.map(partOf),
    people: peopleOf(shown.attendees, organiser.email, colleagues, person),
    fromOrganiser: sender.proved && sender.from === organiser.email,
  };
  await mailReceiver(env, calendarId).invitation(invitation);
}

const GIVEN: Partial<Record<InvitedPerson["answer"], GivenAnswer>> = {
  accepted: "yes",
  tentative: "maybe",
  declined: "no",
};

// An answer is for the whole event, and only from the address that sent it. It's looked
// for in the organiser's own calendar first, then in the team calendars where they can
// change events.
async function takeReplies(
  env: Env,
  organiser: UserId,
  from: EmailAddress,
  events: OutsideEvent[],
): Promise<void> {
  for (const event of events) {
    const theirs = event.attendees.find((one) => one.email === from);
    const answer = theirs && GIVEN[theirs.answer];
    if (event.recurrenceId !== null || !theirs || !answer) continue;
    const reply: OutsideReply = {
      organiser,
      uid: event.uid,
      attendee: { email: from, name: theirs.name },
      stamp: event.stamp,
      answer,
    };
    const personal = await findPersonalCalendar(env.DB, organiser);
    const teams = await editableTeams(env.DB, organiser);
    const rounds: CalendarId[][] = personal ? [[personal]] : [];
    for (let first = 0; first < teams.length; first += CALENDARS_AT_ONCE) {
      rounds.push(teams.slice(first, first + CALENDARS_AT_ONCE));
    }
    for (const round of rounds) {
      const found = await Promise.all(
        round.map((calendarId) => mailReceiver(env, calendarId).reply(reply)),
      );
      if (found.includes(true)) break;
    }
  }
}
