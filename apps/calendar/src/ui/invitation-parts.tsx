import { Button, Notice } from "@cloudysuite/ui";
import type { Icon } from "@tabler/icons-react";
import {
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconHelpCircle,
  IconMailOff,
  IconRefresh,
  IconUser,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { answerInvitation, retryInvitationEmail } from "../functions";
import { call, calendarKeys, outsideInvitingQuery } from "../queries";
import {
  type Answer,
  GIVEN_ANSWERS,
  type GivenAnswer,
  keyOfPerson,
  type NotSent,
} from "../types";
import { useMe } from "./me";
import {
  ANSWER_BUTTONS,
  answerName,
  isMe,
  notSentText,
  peopleSummary,
} from "./people-text";
import type { ShownEvent } from "./shown-event";

const ANSWER_ICONS: Record<Answer, { icon: Icon; tone: string }> = {
  yes: { icon: IconCircleCheck, tone: "text-success" },
  maybe: { icon: IconHelpCircle, tone: "text-secondary" },
  no: { icon: IconCircleX, tone: "text-danger" },
  needsAnswer: { icon: IconCircleDashed, tone: "text-secondary" },
};

// Only on a copy sent to this person, and not once it's been called off.
export function AnswerButtons({ event }: { event: ShownEvent }) {
  const client = useQueryClient();
  const [giving, setGiving] = useState<GivenAnswer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const labelId = useId();
  if (event.answer === null || event.cancelled) return null;

  async function give(answer: GivenAnswer) {
    setGiving(answer);
    setFailure(null);
    try {
      await call(() =>
        answerInvitation({
          data: { calendarId: event.calendarId, uid: event.uid, answer },
        }),
      );
      await client.invalidateQueries({ queryKey: calendarKeys.all });
    } catch (thrown) {
      setFailure((thrown as Error).message);
    } finally {
      setGiving(null);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-wrap items-center gap-1.5"
      >
        <span id={labelId} className="mr-1 text-[13px] text-secondary">
          Going?
        </span>
        {GIVEN_ANSWERS.map((answer) => (
          <Button
            key={answer}
            variant={event.answer === answer ? "toolbarAction" : "toolbar"}
            aria-pressed={event.answer === answer}
            pending={giving === answer}
            disabled={giving !== null}
            onClick={() => void give(answer)}
          >
            {ANSWER_BUTTONS[answer]}
          </Button>
        ))}
      </div>
      {event.organiser.kind === "outside" && (
        <ReplyNote organiser={event.organiser.name ?? event.organiser.email} />
      )}
      {failure && <Notice tone="danger">{failure}</Notice>}
    </div>
  );
}

// An answer to someone outside goes by email from the person's own address. Said before
// they choose, since nothing would tell them afterwards.
function ReplyNote({ organiser }: { organiser: string }) {
  const reach = useQuery(outsideInvitingQuery(null));
  const note = reach.isError
    ? `We couldn't check whether ${organiser} will be told your answer. It's still saved in your calendar either way.`
    : reach.data === "mailOff"
      ? `Mail is off, so ${organiser} won't be told your answer. It's still saved in your calendar.`
      : reach.data === "noSender"
        ? `You don't have a personal mailbox, so ${organiser} won't be told your answer. It's still saved in your calendar.`
        : null;
  return note && <p className="text-xs text-secondary">{note}</p>;
}

export function PeopleSummary({ event }: { event: ShownEvent }) {
  const summary = peopleSummary(event, useMe());
  return summary && <p className="text-[13px] text-secondary">{summary}</p>;
}

function PersonLine({
  name,
  you,
  detail,
  icon: LineIcon,
  tone,
}: {
  name: string;
  you: boolean;
  detail: string;
  icon: Icon;
  tone: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <LineIcon
        size={16}
        stroke={1.75}
        className={`flex-none ${tone}`}
        aria-hidden
      />
      <span dir="auto" className="min-w-0 flex-1 truncate">
        {name}
        {you && <span className="text-secondary"> (you)</span>}
      </span>
      <span className="flex-none text-xs text-secondary">{detail}</span>
    </li>
  );
}

type Person = ShownEvent["people"][number];

// An invitation email that didn't go, or may not have. Try again is offered to anyone
// who can change the event, and the server checks that too.
function NotSentLine({
  event,
  person,
  notSent,
}: {
  event: ShownEvent;
  person: Person;
  notSent: NotSent;
}) {
  const client = useQueryClient();
  const [trying, setTrying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function tryAgain() {
    setTrying(true);
    setFailure(null);
    try {
      await call(() =>
        retryInvitationEmail({
          data: {
            calendarId: event.calendarId,
            uid: event.uid,
            recipient: keyOfPerson(person),
          },
        }),
      );
      await client.invalidateQueries({ queryKey: calendarKeys.all });
    } catch (thrown) {
      setFailure((thrown as Error).message);
    } finally {
      setTrying(false);
    }
  }

  return (
    <li className="flex flex-col gap-1.5 rounded border border-line px-2.5 py-2">
      <span className="flex items-center gap-2 font-semibold text-danger">
        <IconMailOff
          size={16}
          stroke={1.75}
          aria-hidden
          className="flex-none"
        />
        <span dir="auto" className="min-w-0 truncate">
          Not sent to {person.name}
        </span>
      </span>
      <span className="text-secondary">
        {notSentText(notSent, person.name)}
      </span>
      {event.changeable && (
        <span>
          <Button
            variant="toolbar"
            icon={IconRefresh}
            pending={trying}
            onClick={() => void tryAgain()}
          >
            Try again
          </Button>
        </span>
      )}
      {failure && <Notice tone="danger">{failure}</Notice>}
    </li>
  );
}

// The organiser, then everyone invited with their answer, which the organiser's own
// calendar keeps for them.
export function PeopleList({ event }: { event: ShownEvent }) {
  const me = useMe();
  const headingId = useId();
  if (event.people.length === 0) return null;
  const { organiser } = event;
  const organiserName =
    organiser.kind === "outside"
      ? (organiser.name ?? organiser.email)
      : organiser.name;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-[13px] font-semibold">
        People
      </h3>
      <PeopleSummary event={event} />
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {organiserName && (
          <PersonLine
            name={organiserName}
            you={organiser.kind !== "outside" && organiser.userId === me}
            detail="Organiser"
            icon={IconUser}
            tone="text-secondary"
          />
        )}
        {event.people.map((person) => (
          <PersonLine
            key={keyOfPerson(person)}
            name={person.name}
            you={isMe(person, me)}
            detail={answerName(person)}
            {...ANSWER_ICONS[person.answer]}
          />
        ))}
        {event.people.map(
          (person) =>
            person.notSent && (
              <NotSentLine
                key={`not-sent-${keyOfPerson(person)}`}
                event={event}
                person={person}
                notSent={person.notSent}
              />
            ),
        )}
      </ul>
    </section>
  );
}
