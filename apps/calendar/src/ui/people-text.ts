import type { UserId } from "@cloudysuite/access";
import type {
  Answer,
  Attendee,
  GivenAnswer,
  NotSent,
  NotSentReason,
  Occurrence,
} from "../types";

export const ANSWER_NAMES: Record<Answer, string> = {
  yes: "Going",
  maybe: "Maybe",
  no: "Not going",
  needsAnswer: "Not replied",
};

export const ANSWER_BUTTONS: Record<GivenAnswer, string> = {
  yes: "Yes",
  maybe: "Maybe",
  no: "No",
};

// Someone outside answers by email, so until they do there is no answer to show.
export const answerName = (person: Attendee) =>
  person.kind === "outside" && person.answer === "needsAnswer"
    ? "No reply yet"
    : ANSWER_NAMES[person.answer];

// Under "Not sent to" and their name: what happened, and what to do next.
export const NOT_SENT_TEXT: Record<NotSentReason, string> = {
  calendarOff:
    "Calendar was off when the email was due, so it didn't go. Try again now it's back on.",
  mailOff:
    "Mail was off, so the email didn't go. Try again once Mail is back on.",
  changerCantEdit:
    "Whoever made the change can no longer edit this calendar, so the email didn't go. Try again if it should still go.",
  noSender:
    "Emails go from the organiser's own address, which can't send now. Their mailbox may be gone, or their account suspended. Ask your admin, then try again.",
  checkUnavailable:
    "We couldn't confirm the email was still allowed to go, so it didn't. Try again in a few minutes.",
  rateLimited:
    "Too much mail was going out, so the email didn't go. Try again in a few minutes.",
  senderNotVerified:
    "The organiser's address isn't set up to send mail yet. Ask your admin to finish setting up the domain, then try again.",
  dailyLimit:
    "Your organisation reached today's sending limit. Try again tomorrow.",
  accountSuspended:
    "Cloudflare has paused sending for your organisation. Ask your admin to check the Cloudflare account.",
  recipientNotAllowed:
    "Your organisation's settings don't allow mail to this address. Ask your admin.",
  recipientSuppressed:
    "This address can't get mail from your organisation, because an earlier message bounced or was reported. Check the address with them.",
  deliveryRefused:
    "Their mail server refused the email. Check the address, then try again.",
  invalidMessage:
    "Something in this invitation couldn't be sent. Check the address, then try again.",
};

export const notSentText = (notSent: NotSent, name: string) =>
  notSent.kind === "unclear"
    ? `We can't tell whether the email reached ${name}. Check with them before you try again.`
    : NOT_SENT_TEXT[notSent.reason];

const IN_ORDER: Answer[] = ["yes", "maybe", "no", "needsAnswer"];

const counted = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

// "Maya Chen, Jo Okafor and 2 others"
function namesOf(people: readonly Attendee[]): string {
  const names = people.slice(0, 3).map((person) => person.name);
  const rest = people.length - names.length;
  if (rest > 0) names.push(counted(rest, "other", "others"));
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function organiserOf(event: Pick<Occurrence, "organiser">, me: UserId) {
  const { organiser } = event;
  if (organiser.kind === "madeHere" && organiser.userId === me) return "You";
  if (organiser.kind === "outside") return organiser.name ?? organiser.email;
  return organiser.name ?? "The organiser";
}

export const isMe = (person: Attendee, me: UserId) =>
  person.kind === "colleague" && person.userId === me;

// "Maya Chen invited you and 3 others. 2 going, 1 maybe, 1 not replied."
export function peopleSummary(
  event: Pick<Occurrence, "organiser"> & { people: readonly Attendee[] },
  me: UserId,
): string | null {
  const { people } = event;
  if (people.length === 0) return null;
  const by = organiserOf(event, me);
  const others = people.filter((person) => !isMe(person, me)).length;
  const invited = people.some((person) => isMe(person, me))
    ? others === 0
      ? `${by} invited you.`
      : `${by} invited you and ${counted(others, "other", "others")}.`
    : `${by} invited ${counted(people.length, "person", "people")}.`;
  const answers = IN_ORDER.flatMap((answer) => {
    const count = people.filter((person) => person.answer === answer).length;
    return count > 0 ? [`${count} ${ANSWER_NAMES[answer].toLowerCase()}`] : [];
  });
  return `${invited} ${answers.join(", ")}.`;
}

// Today's next event says who else is coming and who hasn't replied.
export function comingLine(
  people: readonly Attendee[],
  me: UserId,
): string | null {
  const others = people.filter((person) => !isMe(person, me));
  const going = others.filter((person) => person.answer === "yes");
  const waiting = others.filter((person) => person.answer === "needsAnswer");
  const lines = [
    going.length > 0 &&
      `${namesOf(going)} ${going.length === 1 ? "is" : "are"} going.`,
    waiting.length > 0 &&
      `${namesOf(waiting)} ${waiting.length === 1 ? "hasn't" : "haven't"} replied.`,
  ].filter(Boolean);
  return lines.length > 0 ? lines.join(" ") : null;
}
