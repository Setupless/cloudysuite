import type { UserId } from "@cloudysuite/access";
import type { MyTask, PlainDate, Task } from "../types";
import { addDays, sundayOf } from "./dates";

// Soonest due first and no date last. Among the same day, the newest first, so a task
// just added is easy to find.
export function bySoonestDue(a: Task, b: Task): number {
  if (a.due !== b.due) {
    if (a.due === null) return 1;
    if (b.due === null) return -1;
    return a.due < b.due ? -1 : 1;
  }
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

const byLatestDone = (a: Task, b: Task) =>
  (b.doneAt ?? 0) - (a.doneAt ?? 0) || a.id.localeCompare(b.id);

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
  const open = mine.filter((task) => task.status !== "done").sort(bySoonestDue);
  return {
    groups: MY_GROUPS.map((group) => ({
      group,
      tasks: open.filter((task) => groupOf(task.due, today) === group),
    })).filter(({ tasks }) => tasks.length > 0),
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
