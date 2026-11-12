import { expect, test } from "bun:test";
import type { BoardId, UserId } from "@cloudysuite/access";
import type { MyTask, PlainDate, Task, TaskId } from "../types";
import { dueText } from "./dates";
import { boardSections, planMyTasks } from "./task-order";

const ME = "user-me" as UserId;
const OTHER = "user-other" as UserId;
// A Thursday.
const TODAY = "2026-11-12" as PlainDate;
const dayOf = (at: number) =>
  new Date(at).toISOString().slice(0, 10) as PlainDate;

let made = 0;
function task(more: Partial<Task> = {}): Task {
  made++;
  return {
    id: `task-${made}` as TaskId,
    title: `Task ${made}`,
    status: "todo",
    assignee: { id: ME, name: "Me" },
    due: null,
    notes: "",
    checklist: [],
    createdBy: { id: ME, name: "Me" },
    createdAt: made,
    doneAt: null,
    ...more,
  };
}

const team = {
  id: "b1" as BoardId,
  kind: "team",
  name: "Marketing",
  colour: 2,
} as const;
const own = {
  id: "b2" as BoardId,
  kind: "personal",
  name: "Me",
  colour: 4,
} as const;
const onTeam = (more: Partial<Task> = {}): MyTask => ({
  ...task(more),
  board: team,
});
const privately = (more: Partial<Task> = {}): MyTask => ({
  ...task({ assignee: null, ...more }),
  board: own,
});

const titles = (plan: ReturnType<typeof planMyTasks>) =>
  plan.groups.map(({ group, tasks }) => [
    group,
    tasks.map((shown) => shown.title),
  ]);

test("My tasks groups open work by day, and Later this week runs through Sunday", () => {
  const plan = planMyTasks(
    [
      onTeam({ title: "Sunday", due: "2026-11-15" as PlainDate }),
      onTeam({ title: "Next Monday", due: "2026-11-16" as PlainDate }),
      privately({ title: "Someday" }),
      onTeam({ title: "Last week", due: "2026-11-05" as PlainDate }),
      onTeam({ title: "Yesterday", due: "2026-11-11" as PlainDate }),
      privately({ title: "Today", due: TODAY }),
      onTeam({
        title: "Tomorrow",
        due: "2026-11-13" as PlainDate,
        status: "doing",
      }),
      onTeam({ title: "Saturday", due: "2026-11-14" as PlainDate }),
    ],
    ME,
    TODAY,
    dayOf,
  );
  expect(titles(plan)).toEqual([
    ["overdue", ["Last week", "Yesterday"]],
    ["today", ["Today"]],
    ["tomorrow", ["Tomorrow"]],
    ["thisWeek", ["Saturday", "Sunday"]],
    ["later", ["Next Monday"]],
    ["noDate", ["Someday"]],
  ]);
});

test("My tasks leaves out other people's tasks and keeps only what was done today", () => {
  const plan = planMyTasks(
    [
      onTeam({ title: "Theirs", assignee: { id: OTHER, name: "Other" } }),
      onTeam({ title: "Nobody's", assignee: null }),
      onTeam({
        title: "Done this morning",
        status: "done",
        doneAt: Date.parse("2026-11-12T08:00:00Z"),
      }),
      onTeam({
        title: "Done just now",
        status: "done",
        doneAt: Date.parse("2026-11-12T10:00:00Z"),
      }),
      privately({
        title: "Done yesterday",
        status: "done",
        doneAt: Date.parse("2026-11-11T23:00:00Z"),
      }),
    ],
    ME,
    TODAY,
    dayOf,
  );
  expect(plan.groups).toEqual([]);
  expect(plan.doneToday.map((shown) => shown.title)).toEqual([
    "Done just now",
    "Done this morning",
  ]);
});

test("a board shows Doing, then To do, soonest first, and Done newest first", () => {
  const sections = boardSections([
    task({ title: "No date" }),
    task({ title: "Friday", due: "2026-11-13" as PlainDate }),
    task({ title: "Doing", status: "doing" }),
    task({ title: "Done first", status: "done", doneAt: 1 }),
    task({ title: "Done last", status: "done", doneAt: 2 }),
    task({ title: "Today", due: TODAY }),
  ]);
  expect(sections.doing.map((shown) => shown.title)).toEqual(["Doing"]);
  expect(sections.todo.map((shown) => shown.title)).toEqual([
    "Today",
    "Friday",
    "No date",
  ]);
  expect(sections.done.map((shown) => shown.title)).toEqual([
    "Done last",
    "Done first",
  ]);
});

test("a due date reads as a day the person knows", () => {
  expect(dueText(TODAY, TODAY)).toEqual({ text: "Today", tone: "today" });
  expect(dueText("2026-11-11" as PlainDate, TODAY)).toEqual({
    text: "Yesterday",
    tone: "overdue",
  });
  expect(dueText("2026-11-13" as PlainDate, TODAY).text).toBe("Tomorrow");
  expect(dueText("2026-11-15" as PlainDate, TODAY).text).toBe("Sunday");
  expect(dueText("2026-11-10" as PlainDate, TODAY).tone).toBe("overdue");
  expect(dueText("2027-01-04" as PlainDate, TODAY).text).toContain("2027");
});
