// Shared with the browser, so nothing here may import server code.
import type { Task } from "./types";

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

export const byLatestDone = (a: Task, b: Task) =>
  (b.doneAt ?? 0) - (a.doneAt ?? 0) || a.id.localeCompare(b.id);

// Open tasks first, soonest due first, then done tasks, most recently done first.
export function inSearchOrder(a: Task, b: Task): number {
  const aDone = a.status === "done";
  if (aDone !== (b.status === "done")) return aDone ? 1 : -1;
  return aDone ? byLatestDone(a, b) : bySoonestDue(a, b);
}
