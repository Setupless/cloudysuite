import type { DueTask, DueTasks } from "@cloudysuite/tasks/in-calendar";
import { useToast } from "@cloudysuite/ui";
import { IconCheck, IconCircleCheck, IconLock } from "@tabler/icons-react";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  use,
  useState,
} from "react";
import { calendarKeys, call, dueTasksQuery } from "../queries";
import { addDays } from "../time";
import type { CivilDate, EventTime } from "../types";
import { calendarFill } from "./colours";
import { shortDayTitle } from "./event-text";
import { setTaskStatus } from "../task-functions";

const FOCUS =
  "outline-accent focus-visible:outline-2 focus-visible:outline-offset-1";

// The Tasks address, or nothing while Tasks is off for this person.
const TasksAddress = createContext<string | undefined>(undefined);

export function TasksAddressProvider({
  href,
  children,
}: {
  href: string | undefined;
  children: ReactNode;
}) {
  return <TasksAddress value={href}>{children}</TasksAddress>;
}

export const useTasksAddress = () => use(TasksAddress);

const hrefOf = (task: DueTask, tasksHref: string) =>
  new URL(task.path, tasksHref).href;

// Asked only while Tasks is on, and the server says "off" if it was turned off since.
export function useDueTasks(from: CivilDate | null, to: CivilDate) {
  const tasksHref = useTasksAddress();
  const due = useQuery({
    ...dueTasksQuery(from, to),
    enabled: tasksHref !== undefined,
  });
  return { tasksHref, due };
}

export const listedTasks = (due: DueTasks | undefined): DueTask[] =>
  due?.status === "listed" ? due.tasks : [];

export const unreachableBoards = (due: DueTasks | undefined) =>
  due?.status === "listed" ? due.unreachable : 0;

// Overview and Schedule say the same when tasks are missing, and show what did load.
export const TASKS_FAILED =
  "Your tasks couldn't be shown just now. Try again in a moment.";

export const unreachableText = (count: number) =>
  `We couldn't reach ${count === 1 ? "one of your boards" : `${count} of your boards`}, so some tasks may be missing.`;

// The board's colour and name, or a lock and "Only you" for a private task, as in Tasks.
export function BoardName({ board }: { board: DueTask["board"] }) {
  return board.kind === "personal" ? (
    <span className="flex min-w-0 items-center gap-1.5 text-secondary">
      <IconLock size={14} stroke={1.75} className="flex-none" aria-hidden />
      <span className="truncate">Only you</span>
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5 text-secondary">
      <span
        aria-hidden
        className={`size-2.5 flex-none rounded-[3px] ${calendarFill(board.colour)}`}
      />
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

export function dueText(due: CivilDate, today: CivilDate) {
  if (due === today) return { text: "Today", tone: "today" } as const;
  if (due === addDays(today, 1)) {
    return { text: "Tomorrow", tone: "plain" } as const;
  }
  if (due === addDays(today, -1)) {
    return { text: "Yesterday", tone: "overdue" } as const;
  }
  return {
    text: shortDayTitle(due, today),
    tone: due < today ? "overdue" : "plain",
  } as const;
}

const dropTask = (client: QueryClient, task: DueTask) =>
  client.setQueriesData<DueTasks>({ queryKey: calendarKeys.tasks }, (shown) =>
    shown?.status === "listed"
      ? { ...shown, tasks: shown.tasks.filter((other) => other.id !== task.id) }
      : shown,
  );

// Marks the task done in Tasks, with Undo, which puts back the status it had.
function useTick() {
  const client = useQueryClient();
  const toast = useToast();
  const refresh = () =>
    client.invalidateQueries({ queryKey: calendarKeys.tasks });
  const send = (task: DueTask, status: DueTask["status"] | "done") =>
    call(() =>
      setTaskStatus({
        data: { boardId: task.board.id, taskId: task.id, status },
      }),
    );
  async function undo(task: DueTask) {
    try {
      await send(task, task.status);
    } catch (failure) {
      toast({ tone: "danger", message: (failure as Error).message });
    }
    await refresh();
  }
  return async function tick(task: DueTask): Promise<boolean> {
    try {
      await send(task, "done");
    } catch (failure) {
      toast({ tone: "danger", message: (failure as Error).message });
      return false;
    }
    // A read that began before the write would bring the task back when it lands.
    await client.cancelQueries({ queryKey: calendarKeys.tasks });
    dropTask(client, task);
    void refresh();
    toast({
      message: `"${task.title}" is done.`,
      action: { label: "Undo", run: () => void undo(task) },
    });
    return true;
  };
}

// One row of Overview's Tasks due. The circle fills at once and the row leaves once
// Tasks has it.
export function DueTaskRow({
  task,
  today,
  tasksHref,
}: {
  task: DueTask;
  today: CivilDate;
  tasksHref: string;
}) {
  const tick = useTick();
  const [ticking, setTicking] = useState(false);
  const due = dueText(task.due as string as CivilDate, today);
  return (
    <li className="flex items-center gap-1.5 border-b border-line pl-1.5 hover:bg-field">
      <button
        type="button"
        role="checkbox"
        aria-checked={ticking}
        aria-label={`Done: ${task.title}`}
        disabled={ticking}
        className={`group/tick -m-2 flex size-11 flex-none cursor-pointer items-center justify-center rounded-full disabled:cursor-default sm:size-9 ${FOCUS}`}
        onClick={async () => {
          setTicking(true);
          if (!(await tick(task))) setTicking(false);
        }}
      >
        <span
          className={`flex size-[18px] items-center justify-center rounded-full border-[1.5px] ${ticking ? "border-accent bg-accent text-on-accent" : "border-secondary group-hover/tick:border-accent"}`}
        >
          {ticking && <IconCheck size={12} stroke={3} aria-hidden />}
        </span>
      </button>
      <a
        href={hrefOf(task, tasksHref)}
        className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 py-2 pr-2 pl-1 text-sm ${FOCUS}`}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span dir="auto" className="truncate">
            {task.title}
          </span>
          <span
            className={`flex min-w-0 items-center gap-2.5 text-xs text-secondary ${task.status === "doing" ? "" : "sm:hidden"}`}
          >
            {task.status === "doing" && (
              <span className="font-medium text-accent">Doing</span>
            )}
            <span className="min-w-0 sm:hidden">
              <BoardName board={task.board} />
            </span>
          </span>
        </span>
        <span className="flex w-32 text-xs max-sm:hidden">
          <BoardName board={task.board} />
        </span>
        <span
          className={`w-[4.75rem] truncate text-right text-xs sm:w-24 ${DUE_TONES[due.tone]}`}
        >
          {due.text}
        </span>
      </a>
    </li>
  );
}

// A task in Schedule's all-day row, laid out with the events but drawn unlike one.
export type ShownTask = {
  key: string;
  title: string;
  time: EventTime;
  trailing: true;
  task: DueTask;
};

export const shownTasks = (tasks: DueTask[]): ShownTask[] =>
  tasks.map((task) => {
    const due = task.due as string as CivilDate;
    return {
      key: `task/${task.id}`,
      title: task.title,
      time: { kind: "allDay", startDate: due, endDate: addDays(due, 1) },
      trailing: true,
      task,
    };
  });

export const isTask = (item: object): item is ShownTask => "task" in item;

export function TaskChip({
  item,
  style,
  className,
}: {
  item: ShownTask;
  style: CSSProperties;
  className: string;
}) {
  const tasksHref = useTasksAddress();
  if (!tasksHref) return null;
  const { task } = item;
  const where = task.board.kind === "personal" ? "only you" : task.board.name;
  return (
    <a
      href={hrefOf(task, tasksHref)}
      aria-label={`Task: ${task.title}, ${where}. Opens in Tasks`}
      style={style}
      className={`flex min-w-0 items-center gap-1 border border-line bg-page text-xs leading-[22px] text-text hover:bg-field ${FOCUS} ${className}`}
    >
      <IconCircleCheck
        size={13}
        stroke={2}
        className="flex-none text-secondary"
        aria-hidden
      />
      <span className="truncate" dir="auto">
        {task.title}
      </span>
    </a>
  );
}
