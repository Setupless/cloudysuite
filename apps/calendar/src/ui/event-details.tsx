import { Button } from "@cloudysuite/ui";
import type { Icon } from "@tabler/icons-react";
import {
  IconArrowsDiagonal,
  IconCalendar,
  IconCalendarX,
  IconClock,
  IconMapPin,
  IconPencil,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CivilDate, TimeZone } from "../types";
import { calendarFill } from "./colours";
import { controlsFor } from "./event-form";
import { repeatText, whoCanSee, withLinks } from "./event-text";
import { JoinButton, meetingOf } from "./join-button";
import { type ShownEvent, whenOf } from "./shown-event";

const FOCUS = "outline-accent focus-visible:outline-2";
const GAP = 6;
const EDGE = 8;

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
  detail,
  children,
}: {
  icon: Icon;
  detail?: string;
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
      <div className="min-w-0 break-words">
        {children}
        {detail && <p className="text-xs text-secondary">{detail}</p>}
      </div>
    </li>
  );
}

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

function EventFacts({
  event,
  zone,
  today,
}: {
  event: ShownEvent;
  zone: TimeZone;
  today: CivilDate;
}) {
  const { days, hours } = whenOf(event, zone, today);
  const repeat = event.repeat && repeatText(event.repeat, today);
  const detail =
    hours && repeat
      ? `${hours}, ${lowerFirst(repeat)}`
      : hours || repeat || undefined;
  return (
    <ul className="flex flex-col gap-2.5 text-[13px]">
      <Fact icon={IconClock} detail={detail}>
        <p>{days}</p>
      </Fact>
      {event.location && (
        <Fact icon={IconMapPin}>
          <p dir="auto">
            <LinkedText text={event.location} />
          </p>
        </Fact>
      )}
      <Fact icon={IconCalendar} detail={whoCanSee(event.calendar)}>
        <p dir="auto">{event.calendar.name}</p>
      </Fact>
    </ul>
  );
}

function EventHeading({
  event,
  titleId,
  onClose,
}: {
  event: ShownEvent;
  titleId: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <span
        aria-hidden
        className={`mt-1.5 size-3 flex-none rounded-[4px] ${calendarFill(event.calendar.colour)}`}
      />
      <h2
        id={titleId}
        dir="auto"
        className="min-w-0 flex-1 text-[17px] font-semibold break-words"
      >
        {event.title}
      </h2>
      <button
        type="button"
        aria-label="Close"
        className={`-mt-1 -mr-1.5 flex size-7 flex-none cursor-pointer items-center justify-center rounded text-secondary hover:bg-field ${FOCUS}`}
        onClick={onClose}
      >
        <IconX size={18} stroke={1.75} aria-hidden />
      </button>
    </div>
  );
}

// Called with the button pressed, so focus can go back to it.
export type EventActionHandlers = {
  onEdit: (button: HTMLElement) => void;
  onDelete: (button: HTMLElement) => void;
};

function EventActions({
  event,
  onEdit,
  onDelete,
}: EventActionHandlers & { event: ShownEvent }) {
  switch (controlsFor(event, event.calendar)) {
    case "none":
      return null;
    case "removeOnly":
      return (
        <Button
          variant="toolbar"
          icon={IconCalendarX}
          onClick={(click) => onDelete(click.currentTarget)}
        >
          {event.calendar.kind === "personal"
            ? "Remove from my calendar"
            : "Remove from calendar"}
        </Button>
      );
    case "editAndDelete":
      return (
        <>
          <Button
            variant="toolbar"
            icon={IconPencil}
            onClick={(click) => onEdit(click.currentTarget)}
          >
            Edit
          </Button>
          <Button
            variant="toolbar"
            icon={IconTrash}
            onClick={(click) => onDelete(click.currentTarget)}
          >
            Delete
          </Button>
        </>
      );
  }
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

// Beside the event's day, on the right when it fits and on the left when not, so the
// grid keeps its width.
function besideAnchor(card: HTMLElement, anchor: HTMLElement) {
  const area = (card.offsetParent as HTMLElement).getBoundingClientRect();
  const column = (
    anchor.closest("[data-column]") ?? anchor
  ).getBoundingClientRect();
  const width = card.offsetWidth;
  const right = column.right - area.left + GAP;
  const left = column.left - area.left - GAP - width;
  return {
    left:
      right + width <= area.width - EDGE
        ? right
        : left >= EDGE
          ? left
          : clamp(right, EDGE, area.width - width - EDGE),
    top: clamp(
      anchor.getBoundingClientRect().top - area.top,
      EDGE,
      area.height - card.offsetHeight - EDGE,
    ),
  };
}

export function EventCard({
  event,
  anchor,
  zone,
  today,
  onClose,
  onOpenDetails,
  ...actions
}: EventActionHandlers & {
  event: ShownEvent;
  anchor: HTMLElement;
  zone: TimeZone;
  today: CivilDate;
  // Back to the event when the card closed from the keyboard or its own button.
  onClose: (refocus: boolean) => void;
  onOpenDetails: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const meeting = meetingOf(event);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  // The grid scrolls under the card, so the card follows its event.
  useLayoutEffect(() => {
    const place = () => {
      if (card.current) setPosition(besideAnchor(card.current, anchor));
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  // A hidden card can't take focus, so it waits until the card is placed.
  const placed = position !== null;
  useEffect(() => {
    if (placed) card.current?.focus();
  }, [placed]);

  // Pressing on the event itself is left to that event's own click.
  useEffect(() => {
    const away = (press: PointerEvent) => {
      const target = press.target as Node;
      if (!card.current?.contains(target) && !anchor.contains(target)) {
        onClose(false);
      }
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [anchor, onClose]);

  return (
    <div
      ref={card}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`absolute z-30 flex w-[310px] max-w-[calc(100%-16px)] flex-col gap-2.5 rounded border border-line bg-panel p-3.5 text-text shadow-lg ${FOCUS}`}
      style={position ?? { visibility: "hidden" }}
    >
      <EventHeading
        event={event}
        titleId={titleId}
        onClose={() => onClose(true)}
      />
      <EventFacts event={event} zone={zone} today={today} />
      {meeting && <JoinButton link={meeting} />}
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="toolbar"
          icon={IconArrowsDiagonal}
          onClick={onOpenDetails}
        >
          Open details
        </Button>
        <EventActions event={event} {...actions} />
      </div>
    </div>
  );
}

export function EventPanel({
  event,
  zone,
  today,
  onClose,
  ...actions
}: EventActionHandlers & {
  event: ShownEvent;
  zone: TimeZone;
  today: CivilDate;
  onClose: () => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const meeting = meetingOf(event);
  // On a narrow screen the panel covers the grid, so focus moves here from the event.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  return (
    <aside
      ref={panel}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`flex w-[300px] flex-none flex-col gap-3 overflow-y-auto border-l border-line bg-panel p-3.5 max-sm:absolute max-sm:inset-0 max-sm:z-20 max-sm:w-auto ${FOCUS}`}
    >
      <EventHeading event={event} titleId={titleId} onClose={onClose} />
      <EventFacts event={event} zone={zone} today={today} />
      {meeting && (
        <div className="flex flex-col gap-1.5">
          <JoinButton link={meeting} />
          <p className="text-xs break-all text-secondary">{meeting.url}</p>
        </div>
      )}
      {event.notes && (
        <p dir="auto" className="text-[13px] break-words whitespace-pre-wrap">
          <LinkedText text={event.notes} />
        </p>
      )}
      <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
        <EventActions event={event} {...actions} />
      </div>
    </aside>
  );
}
