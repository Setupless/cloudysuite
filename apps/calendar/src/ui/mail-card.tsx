import { Button, Notice } from "@cloudysuite/ui";
import type { Icon } from "@tabler/icons-react";
import {
  IconCalendarEvent,
  IconCalendarPlus,
  IconCalendarX,
  IconClock,
  IconMapPin,
  IconTrash,
  IconUser,
} from "@tabler/icons-react";
import { type ReactNode, useId, useState } from "react";
import type { CardEvent, InvitationCard } from "../mail-card";
import { todayIn } from "../schedule";
import { parseTimeZone } from "../time";
import {
  type Answer,
  GIVEN_ANSWERS,
  type GivenAnswer,
  type TimeZone,
} from "../types";
import { repeatText, whenText, withLinks } from "./event-text";
import { JoinButton } from "./join-button";
import { ANSWER_BUTTONS } from "./people-text";
import { daySpanOf } from "./schedule-layout";

// The invitation card above a message in Mail. Everything on it came from an email or
// from a calendar an email wrote to, so it's plain text, and only https links open.

export type CardActions = {
  answer(answer: GivenAnswer): Promise<void>;
  add(): Promise<void>;
  remove(): Promise<void>;
};

const FOCUS = "outline-accent focus-visible:outline-2";

const deviceZone = () =>
  parseTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
  ("UTC" as TimeZone);

function LinkedText({ text }: { text: string }) {
  return withLinks(text).map((segment, index) =>
    segment.kind === "text" ? (
      segment.text
    ) : (
      <a
        key={index}
        href={segment.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`break-all text-accent underline ${FOCUS}`}
      >
        {segment.text}
      </a>
    ),
  );
}

function Fact({
  icon: FactIcon,
  children,
}: {
  icon: Icon;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <FactIcon
        size={18}
        stroke={1.75}
        className="mt-px flex-none text-secondary"
        aria-hidden
      />
      <div className="min-w-0 break-words">{children}</div>
    </li>
  );
}

function EventFacts({ event }: { event: CardEvent }) {
  const [zone] = useState(deviceZone);
  const today = todayIn(zone, Date.now());
  const { first, last } = daySpanOf(event.time, zone);
  const { days, hours } = whenText(event.time, first, last, today);
  const repeat = event.repeat && repeatText(event.repeat, today);
  return (
    <ul className="flex flex-col gap-2 text-[13px]">
      <Fact icon={IconClock}>
        <p>{days}</p>
        {(hours || repeat) && (
          <p className="text-xs text-secondary">
            {[hours, repeat].filter(Boolean).join(", ")}
          </p>
        )}
      </Fact>
      {event.location && (
        <Fact icon={IconMapPin}>
          <p dir="auto">
            <LinkedText text={event.location} />
          </p>
        </Fact>
      )}
      {event.organiser && (
        <Fact icon={IconUser}>
          <p>
            Organised by <bdi>{event.organiser}</bdi>
          </p>
        </Fact>
      )}
    </ul>
  );
}

const REPLIED: Record<GivenAnswer, string> = {
  yes: "accepted",
  maybe: "replied maybe",
  no: "declined",
};

const NOW_SHOWN: Record<Answer, string> = {
  yes: "Your calendar now shows them as going.",
  maybe: "Your calendar now shows them as maybe going.",
  no: "Your calendar now shows them as not going.",
  needsAnswer: "Your calendar shows no answer from them yet.",
};

type Shown = {
  icon: Icon;
  label: string;
  // What the person's calendar makes of this email, in plain words.
  notes: string[];
  answers: { current: Answer; organiserTold: boolean } | null;
  add: boolean;
  remove: boolean;
};

const OFF_NOTE =
  "Calendar is off, so this can't be answered or added to your calendar from here. Ask your admin to turn Calendar back on.";

function versionNote(
  version: "later" | "same" | "earlier",
  confirmed: boolean,
): string | null {
  if (version === "later") {
    return "This event has changed since this email. The card shows it as your calendar has it now.";
  }
  if (version === "same") return null;
  return confirmed
    ? "This email's change isn't in your calendar, so the card shows the event as your calendar has it."
    : "This email changes the event, but the sender couldn't be confirmed, so your calendar keeps it as it was.";
}

function shownOf(card: InvitationCard): Shown {
  const none = { answers: null, add: false, remove: false };
  if (card.kind === "reply") {
    const { standing } = card;
    const note =
      standing.kind === "calendarOff"
        ? "Calendar is off, so this card can't show whether the answer is in your calendar."
        : standing.kind === "notConfirmed"
          ? "The sender couldn't be confirmed, so this answer wasn't recorded."
          : standing.kind === "noEvent"
            ? "This answer is about an event that isn't in your calendars, so it wasn't recorded."
            : standing.answer === card.answer
              ? "Their answer is in your calendar."
              : NOW_SHOWN[standing.answer];
    return {
      ...none,
      icon: IconCalendarEvent,
      label: `${card.who} ${REPLIED[card.answer]}`,
      notes: [note],
    };
  }

  if (card.kind === "cancellation") {
    const { standing, someDates } = card;
    const base = {
      ...none,
      icon: IconCalendarX,
      label: someDates ? "A date was cancelled" : "Cancelled",
    };
    switch (standing.kind) {
      case "calendarOff":
        return {
          ...base,
          notes: [
            "Calendar is off, so this card can't show whether the event is still in your calendar.",
          ],
        };
      case "notHeld":
        return { ...base, notes: ["This event isn't in your calendar."] };
      case "held": {
        const still = !standing.confirmed
          ? "The sender couldn't be confirmed, so the event is still in your calendar as it was."
          : standing.version === "later"
            ? "The event has changed since this was sent, and it's still in your calendar."
            : "The event is still in your calendar.";
        const marked = someDates
          ? "Your calendar marks this date as cancelled."
          : "Your calendar marks the event as cancelled.";
        return {
          ...base,
          notes: [standing.cancelled ? marked : still],
          remove: !someDates,
        };
      }
    }
  }

  const { standing, someDates } = card;
  const base = {
    ...none,
    icon: IconCalendarEvent,
    label: someDates ? "A date changed" : "Invitation",
  };
  switch (standing.kind) {
    case "calendarOff":
      return { ...base, notes: [OFF_NOTE] };
    case "removed":
      return {
        ...base,
        notes: ["You removed this event from your calendar."],
        add: standing.addable,
      };
    case "notHeld":
      return {
        ...base,
        notes: [
          standing.addable
            ? "This invitation isn't in your calendar."
            : someDates
              ? "This email changes an event that isn't in your calendar."
              : "This invitation is from a colleague, and it isn't in your calendar. If you were invited, it arrives in Calendar by itself.",
        ],
        add: standing.addable,
      };
    case "held": {
      if (standing.cancelled) {
        return {
          ...base,
          notes: [
            "This event was cancelled. It's still in your calendar, marked as cancelled.",
          ],
          remove: true,
        };
      }
      const version = versionNote(standing.version, standing.confirmed);
      return {
        ...base,
        notes: [
          ...(standing.answer === null
            ? ["This event is in your calendar."]
            : []),
          ...(version ? [version] : []),
        ],
        answers:
          standing.answer === null
            ? null
            : {
                current: standing.answer,
                organiserTold: standing.organiserTold,
              },
      };
    }
  }
}

type Pending = GivenAnswer | "add" | "remove" | null;

export function MailInvitationCard({
  card,
  actions,
}: {
  card: InvitationCard;
  actions: CardActions;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = useId();
  const answersId = useId();
  const shown = shownOf(card);
  const { event } = card;

  async function run(
    what: Exclude<Pending, null>,
    action: () => Promise<void>,
  ) {
    setPending(what);
    setFailure(null);
    try {
      await action();
    } catch (thrown) {
      setFailure((thrown as Error).message);
    } finally {
      setPending(null);
    }
  }

  const organiser = event.organiser ?? "the organiser";
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded border border-line bg-panel px-4 py-3"
    >
      <div className="flex flex-col gap-1">
        <p
          className={`flex items-center gap-1.5 text-xs font-semibold ${card.kind === "cancellation" ? "text-danger" : "text-secondary"}`}
        >
          <shown.icon size={16} stroke={1.75} aria-hidden />
          <bdi className="min-w-0 truncate">{shown.label}</bdi>
        </p>
        <h3
          id={titleId}
          dir="auto"
          className="text-[15px] font-semibold break-words"
        >
          {event.title || "No title"}
        </h3>
      </div>
      <EventFacts event={event} />
      {event.join && <JoinButton link={event.join} />}
      {shown.notes.map((note) => (
        <p key={note} className="text-[13px] text-secondary">
          {note}
        </p>
      ))}
      {shown.answers && (
        <div className="flex flex-col gap-1.5">
          <div
            role="group"
            aria-labelledby={answersId}
            className="flex flex-wrap items-center gap-1.5"
          >
            <span id={answersId} className="mr-1 text-[13px] text-secondary">
              Going?
            </span>
            {GIVEN_ANSWERS.map((answer) => (
              <Button
                key={answer}
                variant={
                  shown.answers?.current === answer
                    ? "toolbarAction"
                    : "toolbar"
                }
                aria-pressed={shown.answers?.current === answer}
                pending={pending === answer}
                disabled={pending !== null}
                onClick={() => void run(answer, () => actions.answer(answer))}
              >
                {ANSWER_BUTTONS[answer]}
              </Button>
            ))}
          </div>
          {!shown.answers.organiserTold && (
            <p className="text-xs text-secondary">
              You don't have a personal mailbox, so <bdi>{organiser}</bdi> won't
              be told your answer. It's still saved in your calendar.
            </p>
          )}
        </div>
      )}
      {(shown.add || shown.remove) && (
        <div className="flex flex-wrap gap-1.5">
          {shown.add && (
            <Button
              variant="toolbarAction"
              icon={IconCalendarPlus}
              pending={pending === "add"}
              disabled={pending !== null}
              onClick={() => void run("add", actions.add)}
            >
              Add to my calendar
            </Button>
          )}
          {shown.remove && (
            <Button
              variant="toolbar"
              icon={IconTrash}
              pending={pending === "remove"}
              disabled={pending !== null}
              onClick={() => void run("remove", actions.remove)}
            >
              Remove from my calendar
            </Button>
          )}
        </div>
      )}
      {failure && <Notice tone="danger">{failure}</Notice>}
    </section>
  );
}
