import type { BoardRole, UserId } from "@cloudysuite/access";
import { Avatar } from "@cloudysuite/ui";
import { IconCheck, IconLock } from "@tabler/icons-react";
import type { BoardOfTask, Person, PlainDate, TaskMoving } from "../types";
import { dueText } from "./dates";

export const FOCUS = "outline-accent focus-visible:outline-2";

export const canEditWith = (role: BoardRole) =>
  role === "manager" || role === "editor";

// Written out in full, because Tailwind only makes the classes it finds in the source.
const FILLS = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
];

export const boardFill = (colour: number) => FILLS[(colour - 1) % FILLS.length];

export function BoardSwatch({ colour }: { colour: number }) {
  return (
    <span
      aria-hidden
      className={`size-2.5 flex-none rounded-[3px] ${boardFill(colour)}`}
    />
  );
}

// A private task says so, with a lock, in place of a board.
export function BoardName({ board }: { board: BoardOfTask }) {
  return board.kind === "personal" ? (
    <span className="flex min-w-0 items-center gap-1.5 text-secondary">
      <IconLock size={14} stroke={1.75} className="flex-none" aria-hidden />
      <span className="truncate">Only you</span>
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5 text-secondary">
      <BoardSwatch colour={board.colour} />
      <span className="truncate" dir="auto">
        {board.name}
      </span>
    </span>
  );
}

const DUE_TONES = {
  overdue: "text-danger",
  today: "font-medium text-accent",
  plain: "text-secondary",
};

export function DueLabel({
  due,
  today,
}: {
  due: PlainDate | null;
  today: PlainDate;
}) {
  if (!due) return null;
  const { text, tone } = dueText(due, today);
  return <span className={`truncate ${DUE_TONES[tone]}`}>{text}</span>;
}

// Avatars pick their colour from an email. A task keeps only a name, so the id stands in
// for someone no longer on the board.
export function PersonAvatar({
  person,
  email,
}: {
  person: Person;
  email: string | undefined;
}) {
  return (
    <Avatar
      person={{ name: person.name, email: email ?? person.id }}
      size="small"
    />
  );
}

// The circle that marks a task done. Its tap area is 44px on a phone.
export function TickButton({
  done,
  title,
  disabled,
  onTick,
}: {
  done: boolean;
  title: string;
  disabled: boolean;
  onTick: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={`Done: ${title}`}
      disabled={disabled}
      className={`group/tick -m-2 flex size-11 flex-none cursor-pointer items-center justify-center rounded-full disabled:cursor-default sm:size-9 ${FOCUS}`}
      onClick={(click) => {
        click.stopPropagation();
        onTick();
      }}
    >
      <span
        className={`flex size-[18px] items-center justify-center rounded-full border-[1.5px] ${done ? "border-accent bg-accent text-on-accent" : "border-secondary group-hover/tick:border-accent"} group-disabled/tick:opacity-60`}
      >
        {done && <IconCheck size={12} stroke={3} aria-hidden />}
      </span>
    </button>
  );
}

// What a board shows on a task on its way to another.
export const movingText = (moving: TaskMoving, me: UserId) =>
  moving.kind === "team"
    ? `Moving to ${moving.name}…`
    : moving.by === me
      ? "Moving to your private tasks…"
      : `Moving to ${moving.name}'s private tasks…`;
