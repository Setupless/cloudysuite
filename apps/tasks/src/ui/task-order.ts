import type { UserId } from "@cloudysuite/access";
import type { MyTask, PlainDate, Task } from "../types";
import { byLatestDone, bySoonestDue } from "../order";
import { addDays, sundayOf } from "./dates";

export const MY_GROUPS = [
  "overdue",
  "today",
  "tomorrow",
  "thisWeek",
  "later",
  "noDate",
] as const;
export type MyGroup = (typeof MY_GROUPS)[number];

export const MY_GROUP_TITLES: Record<MyGroup, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  thisWeek: "Later this week",
  later: "Later",
  noDate: "No date",
};

function groupOf(due: PlainDate | null, today: PlainDate): MyGroup {
  if (due === null) return "noDate";
  if (due < today) return "overdue";
  if (due === today) return "today";
  if (due === addDays(today, 1)) return "tomorrow";
  return due <= sundayOf(today) ? "thisWeek" : "later";
}

// The open tasks, as Overdue, Today, and so on, leaving out empty groups.
export function dueGroups<Shown extends Task>(
  tasks: readonly Shown[],
  today: PlainDate,
) {
  const open = tasks
    .filter((task) => task.status !== "done")
    .sort(bySoonestDue);
  return MY_GROUPS.map((group) => ({
    group,
    tasks: open.filter((task) => groupOf(task.due, today) === group),
  })).filter(({ tasks }) => tasks.length > 0);
}

// What's still mine. A task given to someone else leaves My tasks, even when its panel
// is open.
export const isMine = (task: MyTask, me: UserId) =>
  task.board.kind === "personal" || task.assignee?.id === me;

export function planMyTasks(
  tasks: readonly MyTask[],
  me: UserId,
  today: PlainDate,
  dayOf: (at: number) => PlainDate,
) {
  const mine = tasks.filter((task) => isMine(task, me));
  return {
    groups: dueGroups(mine, today),
    doneToday: mine
      .filter(
        (task) =>
          task.status === "done" &&
          task.doneAt !== null &&
          dayOf(task.doneAt) === today,
      )
      .sort(byLatestDone),
  };
}

export function boardSections(tasks: readonly Task[]) {
  const withStatus = (status: Task["status"]) =>
    tasks.filter((task) => task.status === status);
  return {
    doing: withStatus("doing").sort(bySoonestDue),
    todo: withStatus("todo").sort(bySoonestDue),
    done: withStatus("done").sort(byLatestDone),
  };
}

// A board filtered to one person shows only what's assigned to them.
export const assignedTo = <Shown extends Task>(
  tasks: readonly Shown[],
  userId: UserId | null,
): Shown[] =>
  userId === null
    ? [...tasks]
    : tasks.filter((task) => task.assignee?.id === userId);
