import type { UserId } from "@cloudysuite/access";
import { IconListCheck } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { BoardOfTask, PlainDate, Task } from "../types";
import { BoardName, DueLabel, FOCUS, PersonAvatar, TickButton } from "./parts";

// Where the row is: My tasks names each task's board, and a board names who has it.
export type RowPlace =
  | { kind: "mine"; board: BoardOfTask }
  | {
      kind: "board";
      teamBoard: boolean;
      // Each member's email, which picks their avatar's colour as everywhere else.
      emails: ReadonlyMap<UserId, string>;
    };

function ChecklistCount({ task }: { task: Task }) {
  if (task.checklist.length === 0) return null;
  const done = task.checklist.filter((item) => item.done).length;
  return (
    <span
      className="flex flex-none items-center gap-1 tabular-nums"
      aria-label={`${done} of ${task.checklist.length} checklist items done`}
    >
      <IconListCheck size={14} stroke={1.75} aria-hidden />
      {done}/{task.checklist.length}
    </span>
  );
}

function Meta({ children }: { children: ReactNode[] }) {
  const shown = children.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-2.5 text-xs text-secondary">
      {shown}
    </span>
  );
}

export function TaskRow({
  task,
  place,
  today,
  open,
  canTick,
  onOpen,
  onTick,
}: {
  task: Task;
  place: RowPlace;
  today: PlainDate;
  open: boolean;
  canTick: boolean;
  onOpen: () => void;
  onTick: () => void;
}) {
  const done = task.status === "done";
  const showsAssignee = place.kind === "board" && place.teamBoard;
  return (
    <li
      data-task-id={task.id}
      className={`flex items-center gap-1.5 border-b border-line pl-1.5 ${open ? "bg-selected" : "hover:bg-field"}`}
    >
      <TickButton
        done={done}
        title={task.title}
        disabled={!canTick}
        onTick={onTick}
      />
      <button
        type="button"
        aria-expanded={open}
        className={`flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 py-2 pr-2 pl-1 text-left text-sm ${FOCUS}`}
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            dir="auto"
            className={`truncate ${done ? "text-secondary line-through" : ""}`}
          >
            {task.title}
          </span>
          <Meta>
            {[
              place.kind === "mine" && task.status === "doing" && (
                <span key="doing" className="font-medium text-accent">
                  Doing
                </span>
              ),
              <ChecklistCount key="checklist" task={task} />,
              place.kind === "mine" && (
                <span key="board" className="min-w-0 sm:hidden">
                  <BoardName board={place.board} />
                </span>
              ),
            ]}
          </Meta>
        </span>
        {place.kind === "mine" && (
          <span className="flex w-32 text-xs max-sm:hidden">
            <BoardName board={place.board} />
          </span>
        )}
        {showsAssignee && (
          <span className="flex w-[22px] items-center gap-1.5 text-xs sm:w-32">
            {task.assignee ? (
              <>
                <PersonAvatar
                  person={task.assignee}
                  email={place.emails.get(task.assignee.id)}
                />
                <span className="truncate max-sm:hidden">
                  {task.assignee.name}
                </span>
              </>
            ) : (
              <span className="text-secondary max-sm:sr-only">Nobody yet</span>
            )}
          </span>
        )}
        <span className="flex w-[4.75rem] justify-end text-right text-xs sm:w-24">
          <DueLabel due={task.due} today={today} />
        </span>
      </button>
    </li>
  );
}
