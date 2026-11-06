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
  OutsidePerson,
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
  MAX_EVENTS_PER_EMAIL,
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

export type Taken<Method extends CalendarMethod> = {
  method: Method;
  group: EventGroup;
};

// Google sends the same file twice, as the invitation and as invite.ics, so the parts
// are read together and each event counts once for each method.
export function eventsOf(parts: string[]): Taken<CalendarMethod>[] {
  const byMethod = new Map<CalendarMethod, OutsideEvent[]>();
  for (const text of new Set(parts)) {
    const reading = readCalendarFile(text, UTC, LIMITS);
    if (reading.status !== "read" || !reading.method) continue;
    byMethod.set(reading.method, [
      ...(byMethod.get(reading.method) ?? []),
      ...reading.events,
    ]);
  }
  return [...byMethod]
    .flatMap(([method, events]) =>
      groupByEvent(events).map((group) => ({ method, group })),
    )
    .slice(0, MAX_EVENTS_PER_EMAIL);
}

export const isReply = (
  taken: Taken<CalendarMethod>,
): taken is Taken<"reply"> => taken.method === "reply";

// The one way Mail reaches Calendar, from Mail's alarm. Mail stored the message before
// this runs, so nothing here can lose or hold up mail. A throw asks Mail to try again
// later, which changes nothing twice, because UID and sequence decide. The directory is
// asked once for the whole email, whatever it holds.
export async function receiveCalendarMail(
  env: Env,
  mail: CalendarMail,
): Promise<void> {
  if (await isAppOff(env.DB, "calendar")) return;
  const person = await personOfMailbox(env.DB, mail.mailboxId);
  if (!person) return;
  const from = parseEmailAddress(mail.from);
  const events = eventsOf(mail.parts);
  await takeInvitations(
    env,
    person,
    events.filter((one): one is Taken<"request" | "cancel"> => !isReply(one)),
    { from, proved: mail.proved },
  );
  if (from && mail.proved) {
    await takeReplies(env, person.id, from, events.filter(isReply));
  }
}

export const partOf = (event: OutsideEvent): OutsidePart => ({
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

export type Person = { id: UserId; name: string };

// The person whose calendar it is shows as themselves, by their own name, so their
// answer is on the list and the sender can't choose what it's sent under. Google lists
// the organiser as a guest too, and People already names them.
export function peopleOf(
  invited: InvitedPerson[],
  organiser: EmailAddress,
  colleagues: Map<EmailAddress, UserId>,
  person: Person,
): Attendee[] {
  const people = invited.flatMap((one): Attendee[] => {
    if (one.email === organiser) return [];
    const answer = ANSWERS[one.answer];
    return [
      colleagues.get(one.email) === person.id
        ? {
            kind: "colleague",
            userId: person.id,
            name: person.name.slice(0, MAX_PERSON_NAME_LENGTH),
            answer,
          }
        : {
            kind: "outside",
            email: one.email,
            name: (one.name ?? one.email).slice(0, MAX_PERSON_NAME_LENGTH),
            answer,
          },
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

async function takeInvitations(
  env: Env,
  person: Person,
  taken: Taken<"request" | "cancel">[],
  sender: { from: EmailAddress | null; proved: boolean },
): Promise<void> {
  const shown = taken.flatMap(({ method, group }) => {
    const event = group.series ?? group.changes[0];
    const organiser = event?.organiser;
    return event && organiser ? [{ method, group, event, organiser }] : [];
  });
  if (shown.length === 0) return;
  const colleagues = await colleaguesAt(
    env.DB,
    shown.flatMap(({ event, organiser }) => [
      organiser.email,
      ...event.attendees.map((one) => one.email),
    ]),
  );
  // A colleague's invitation reaches the calendar straight from theirs, under a UID of
  // its own, and its email adds nothing beside it.
  const outside = shown.filter(
    ({ organiser }) => !colleagues.has(organiser.email),
  );
  if (outside.length === 0) return;
  // The first invitation that reaches someone makes their calendar. Nothing else does.
  const calendarId = outside.some(({ method }) => method === "request")
    ? await makePersonalCalendar(env.DB, person.id)
    : await findPersonalCalendar(env.DB, person.id);
  if (!calendarId) return;
  const receiver = mailReceiver(env, calendarId);
  for (const { method, group, organiser } of outside) {
    await receiver.invitation(
      invitationFor({ method, group }, organiser, person, colleagues, sender),
    );
  }
}

export function invitationFor(
  { method, group }: Taken<"request" | "cancel">,
  organiser: OutsidePerson,
  person: Person,
  colleagues: Map<EmailAddress, UserId>,
  sender: { from: EmailAddress | null; proved: boolean },
): OutsideInvitation {
  const event = group.series ?? group.changes[0];
  return {
    method,
    to: person.id,
    uid: group.uid,
    organiser,
    series: group.series && partOf(group.series),
    changes: group.changes.map(partOf),
    people: peopleOf(
      event?.attendees ?? [],
      organiser.email,
      colleagues,
      person,
    ),
    fromOrganiser: sender.proved && sender.from === organiser.email,
  };
}

export const GIVEN: Partial<Record<InvitedPerson["answer"], GivenAnswer>> = {
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
  taken: Taken<"reply">[],
): Promise<void> {
  const replies = taken.flatMap(({ group }): OutsideReply[] => {
    const theirs = group.series?.attendees.find((one) => one.email === from);
    const answer = theirs && GIVEN[theirs.answer];
    if (!group.series || !theirs || !answer) return [];
    return [
      {
        organiser,
        uid: group.uid,
        attendee: { email: from, name: theirs.name },
        stamp: group.series.stamp,
        answer,
      },
    ];
  });
  if (replies.length === 0) return;
  const personal = await findPersonalCalendar(env.DB, organiser);
  const teams = await editableTeams(env.DB, organiser);
  const rounds: CalendarId[][] = personal ? [[personal]] : [];
  for (let first = 0; first < teams.length; first += CALENDARS_AT_ONCE) {
    rounds.push(teams.slice(first, first + CALENDARS_AT_ONCE));
  }
  for (const reply of replies) {
    for (const round of rounds) {
      const found = await Promise.all(
        round.map((calendarId) => mailReceiver(env, calendarId).reply(reply)),
      );
      if (found.includes(true)) break;
    }
  }
}
