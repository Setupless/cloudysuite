import type { UserId } from "@cloudysuite/access";
import type { EmailPort } from "@cloudysuite/app-email";
import { judgeSendError, retryDelay } from "@cloudysuite/mail/send-outcome";
import { canStillEdit } from "../client";
import { findPersonalCalendar } from "../directory";
import { type EmailPlan, heldAfter, type QueuedEmail } from "../invitations";
import type { EventStore } from "../store";
import type {
  Attendee,
  EmailAddress,
  NotSentReason,
  PersonKey,
} from "../types";
import type { IcsAttendee } from "./ics";
import { invitationMime, type SendablePlan } from "./message";
import { readSendingFacts, type SendingFacts } from "./senders";

const EMAILS_PER_WAKE_UP = 25;

type SendFailure = Extract<
  ReturnType<typeof judgeSendError>,
  { kind: "rejected" }
>["failure"];

// The service's refusals, said for the People list.
const REFUSED: Partial<Record<SendFailure, NotSentReason>> = {
  senderNotVerified: "senderNotVerified",
  senderDomainUnavailable: "senderNotVerified",
  dailyLimit: "dailyLimit",
  accountSuspended: "accountSuspended",
  recipientNotAllowed: "recipientNotAllowed",
  recipientSuppressed: "recipientSuppressed",
  deliveryRefused: "deliveryRefused",
};

type Recipient =
  | { kind: "colleague"; userId: UserId }
  | { kind: "outside"; email: EmailAddress };

const recipientOf = (key: PersonKey): Recipient =>
  key.startsWith("user:")
    ? { kind: "colleague", userId: key.slice(5) as UserId }
    : { kind: "outside", email: key.slice(7) as EmailAddress };

const colleaguesIn = (plan: SendablePlan, to: Recipient): UserId[] => [
  ...new Set([
    ...(plan.method === "request"
      ? plan.people.flatMap((person) =>
          person.kind === "colleague" ? [person.userId] : [],
        )
      : []),
    ...(to.kind === "colleague" ? [to.userId] : []),
  ]),
];

function addressOf(person: Attendee, facts: SendingFacts): IcsAttendee | null {
  const address =
    person.kind === "outside"
      ? person.email
      : facts.colleagues.get(person.userId);
  // Someone outside is named by their address alone until they say more.
  const name =
    person.kind === "outside" && person.name === person.email
      ? null
      : person.name;
  return address ? { address, name, answer: person.answer } : null;
}

// The checks Mail's sending makes, for this queue. Calendar off is one too, because
// emails still queued when it's turned off don't go.
function refusalOf(
  facts: SendingFacts,
  canEdit: boolean,
): NotSentReason | null {
  if (facts.calendarOff) return "calendarOff";
  if (facts.mailOff) return "mailOff";
  if (!canEdit) return "changerCantEdit";
  if (!facts.organiser) return "noSender";
  return null;
}

type Context = {
  store: EventStore;
  database: D1Database;
  email: EmailPort;
  // Puts what's been decided on disk before anything leaves.
  saveProgress: () => Promise<void>;
};

function retryOrRefuse(
  { store }: Context,
  queued: QueuedEmail,
  reason: NotSentReason,
  now: number,
): void {
  const delay = retryDelay(queued.tries);
  if (delay === null) store.refuseEmail(queued, reason);
  else store.postponeEmail(queued, now + delay);
}

async function sendOne(
  context: Context,
  queued: QueuedEmail,
  plan: SendablePlan,
  now: number,
): Promise<void> {
  const { store, database, email } = context;
  const to = recipientOf(queued.recipient);
  // A reply goes from the person answering, and only while the calendar is still theirs.
  const sender = plan.method === "reply" ? plan.by : plan.organiser.userId;
  let facts: SendingFacts;
  let canEdit: boolean;
  try {
    [facts, canEdit] = await Promise.all([
      readSendingFacts(database, sender, colleaguesIn(plan, to)),
      plan.method === "reply"
        ? findPersonalCalendar(database, plan.by).then(
            (own) => own === queued.calendarId,
          )
        : // Nobody can edit a deleted calendar. Its manager was checked as they deleted it.
          plan.method === "cancel" && plan.why === "calendarDeleted"
          ? true
          : canStillEdit(database, queued.changedBy, queued.calendarId),
    ]);
  } catch (error) {
    console.error("Could not check whether an invitation may go.", error);
    retryOrRefuse(context, queued, "checkUnavailable", now);
    return;
  }
  const toAddress =
    to.kind === "outside" ? to.email : facts.colleagues.get(to.userId);
  // A colleague with no mailbox has nowhere to get it. Their calendar has the event.
  if (!toAddress) {
    store.dropEmail(queued);
    return;
  }
  const refusal = refusalOf(facts, canEdit);
  if (refusal || !facts.organiser) {
    store.refuseEmail(queued, refusal ?? "noSender");
    return;
  }
  const attendees =
    plan.method === "request"
      ? plan.people.flatMap((person) => {
          const addressed = addressOf(person, facts);
          return addressed ? [addressed] : [];
        })
      : [];
  const toName =
    plan.method === "request"
      ? plan.to.kind === "colleague"
        ? plan.to.name
        : null
      : plan.method === "reply"
        ? plan.organiser.name
        : null;
  const message = invitationMime({
    plan,
    from: {
      address: facts.organiser,
      name: plan.method === "reply" ? plan.byName : plan.organiser.name,
    },
    to: { address: toAddress, name: toName },
    attendees,
    now,
    id: crypto.randomUUID(),
  });

  const held = heldAfter(plan);
  if (!store.claimEmail(queued, held, now)) return;
  await context.saveProgress();
  try {
    await email.send({
      from: facts.organiser,
      to: toAddress,
      raw: message.raw,
    });
  } catch (error) {
    const outcome = judgeSendError(error);
    if (outcome.kind === "temporary") {
      retryOrRefuse(context, queued, "rateLimited", Date.now());
    } else if (outcome.kind === "rejected") {
      store.refuseEmail(queued, REFUSED[outcome.failure] ?? "invalidMessage");
    } else {
      console.error("An invitation email ended without a clear answer.", error);
      store.emailUnclear(queued, held);
    }
    return;
  }
  // Nothing more can be said about an event that's gone.
  if (
    plan.method === "cancel" &&
    (plan.why === "deleted" || plan.why === "calendarDeleted")
  ) {
    store.dropEmail(queued);
  } else {
    store.emailWent(queued, held);
  }
}

// Each step reads where the email stands and does only what's left, so a run after a
// crash at any point converges without a second send.
export async function runDueEmails(
  context: Context,
  now: number,
): Promise<void> {
  const { store } = context;
  for (const queued of store.dueEmails(now, EMAILS_PER_WAKE_UP)) {
    if (queued.state === "sending") {
      // Alarm handlers don't overlap, so whoever claimed this is gone, and there's no
      // telling whether the service took it first.
      store.emailUnclear(queued, queued.sent ?? "request");
      continue;
    }
    try {
      const plan: EmailPlan = store.emailFor(queued);
      if (plan.method === "none") {
        store.dropEmail(queued);
        continue;
      }
      await sendOne(context, queued, plan, Date.now());
    } catch (error) {
      // One that was claimed is left to be found as sending, never tried again.
      console.error("An invitation email stopped.", error);
      store.refuseUnclaimedEmail(queued, "checkUnavailable");
    }
  }
}
