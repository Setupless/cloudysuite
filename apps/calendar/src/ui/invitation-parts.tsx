import { Button, Notice } from "@cloudysuite/ui";
import type { Icon } from "@tabler/icons-react";
import {
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconHelpCircle,
  IconUser,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { answerInvitation } from "../functions";
import { call, calendarKeys } from "../queries";
import { type Answer, GIVEN_ANSWERS, type GivenAnswer } from "../types";
import { useMe } from "./me";
import { ANSWER_BUTTONS, ANSWER_NAMES, peopleSummary } from "./people-text";
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
      {failure && <Notice tone="danger">{failure}</Notice>}
    </div>
  );
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

// The organiser, then everyone invited with their answer, which the organiser's own
// calendar keeps for them.
export function PeopleList({ event }: { event: ShownEvent }) {
  const me = useMe();
  const headingId = useId();
  if (event.people.length === 0) return null;
  const { organiser } = event;
  const organiserName =
    organiser.kind === "invitation"
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
            you={organiser.kind !== "invitation" && organiser.userId === me}
            detail="Organiser"
            icon={IconUser}
            tone="text-secondary"
          />
        )}
        {event.people.map((person) => (
          <PersonLine
            key={person.userId}
            name={person.name}
            you={person.userId === me}
            detail={ANSWER_NAMES[person.answer]}
            {...ANSWER_ICONS[person.answer]}
          />
        ))}
      </ul>
    </section>
  );
}
