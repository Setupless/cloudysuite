import {
  afterEach,
  beforeEach,
  expect,
  jest,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import type { BoardId } from "@cloudysuite/access";
import { dueTasksOf } from "./due";
import type { OpenBoard } from "./search";
import {
  ALICE,
  BOB,
  create,
  createBoardTest,
  date,
  MARKETING,
  newTaskId,
  PRODUCT,
} from "./test-support";
import type { DueRange, Person, PlainDate, TaskChange } from "./types";

let kit: ReturnType<typeof createBoardTest>;
let quiet: ReturnType<typeof spyOn>;
const NOW = Date.parse("2026-11-12T09:00:00Z");
// What Overview asks for on 12 November: anything overdue, today, and tomorrow.
const OVERVIEW: DueRange = { from: null, to: date("2026-11-14") };

beforeEach(() => {
  setSystemTime(NOW);
  kit = createBoardTest();
  kit.join(BOB, "editor");
  quiet = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
  quiet.mockRestore();
});

const opener =
  (person: Person): OpenBoard =>
  (boardId) =>
    kit.as(person, boardId);

let clock = NOW;

async function add(
  title: string,
  due: PlainDate | null,
  more: Partial<Extract<TaskChange, { kind: "create" }>> & {
    status?: "doing" | "done";
    by?: Person;
  } = {},
  boardId: BoardId = MARKETING,
) {
  const { status, by = ALICE, ...creating } = more;
  // Each task is a little newer than the last, as people add them.
  setSystemTime((clock += 1_000));
  const board = await kit.as(by, boardId);
  const id = newTaskId();
  const result = await board.change(create(id, { title, due, ...creating }));
  if (result.status !== "done") throw new Error(`expected ${title}`);
  if (status) await board.change({ kind: "setStatus", id, status });
  return id;
}

const due = (
  person: Person,
  range: DueRange = OVERVIEW,
  open = opener(person),
) => dueTasksOf(kit.d1, person, open, range);

const titlesOf = (answer: { tasks: { title: string }[] }) =>
  answer.tasks.map((task) => task.title);

test("only the person's own open tasks show, overdue, then today, then tomorrow, soonest first", async () => {
  const mine = { assignee: ALICE };
  await add("Tomorrow's", date("2026-11-13"), mine);
  await add("Today's, added first", date("2026-11-12"), mine);
  await add("Last week's", date("2026-11-05"), mine);
  await add("Today's, added last", date("2026-11-12"), {
    ...mine,
    status: "doing",
  });
  await add("Yesterday's", date("2026-11-11"), mine);
  await add("Done already", date("2026-11-12"), { ...mine, status: "done" });
  await add("Bob's", date("2026-11-12"), { assignee: BOB });
  await add("Nobody's yet", date("2026-11-12"));
  await add("Next week's", date("2026-11-19"), mine);
  await add("No date", null, mine);
  const alicePrivate = await kit.personalBoardOf(ALICE);
  await add("Private today", date("2026-11-12"), {}, alicePrivate);
  const bobPrivate = await kit.personalBoardOf(BOB);
  await add("Bob's private", date("2026-11-12"), { by: BOB }, bobPrivate);

  const answer = await due(ALICE);
  expect(answer.unreachable).toBe(0);
  expect(titlesOf(answer)).toEqual([
    "Last week's",
    "Yesterday's",
    "Private today",
    "Today's, added last",
    "Today's, added first",
    "Tomorrow's",
  ]);
  expect(answer.tasks[3]?.status).toBe("doing");
  expect(titlesOf(await due(BOB))).toEqual(["Bob's private", "Bob's"]);
});

test("each task says its board and where it opens in Tasks", async () => {
  const team = await add("On Marketing", date("2026-11-12"), {
    assignee: ALICE,
  });
  const personal = await kit.personalBoardOf(ALICE);
  const own = await add("Only mine", date("2026-11-12"), {}, personal);

  const { tasks } = await due(ALICE);
  expect(tasks.map(({ id, board, path }) => ({ id, board, path }))).toEqual([
    {
      id: own,
      board: {
        id: personal,
        kind: "personal",
        name: ALICE.name,
        colour: expect.any(Number),
      },
      path: `/?task=${own}`,
    },
    {
      id: team,
      board: { id: MARKETING, kind: "team", name: "Marketing", colour: 2 },
      path: `/boards/${MARKETING}?task=${team}`,
    },
  ]);
});

test("Schedule's range returns only the tasks due on its days", async () => {
  const mine = { assignee: ALICE };
  await add("Sunday before", date("2026-11-08"), mine);
  await add("Monday", date("2026-11-09"), mine);
  await add("Sunday", date("2026-11-15"), mine);
  await add("Next Monday", date("2026-11-16"), mine);
  await add("On Product", date("2026-11-11"), mine, PRODUCT);

  const week = { from: date("2026-11-09"), to: date("2026-11-16") };
  expect(titlesOf(await due(ALICE, week))).toEqual([
    "Monday",
    "On Product",
    "Sunday",
  ]);
});

test("someone removed from a board no longer sees its tasks", async () => {
  await add("Bob's on Marketing", date("2026-11-12"), { assignee: BOB });
  kit.directory.run("DELETE FROM board_access WHERE user_id = ?", [BOB.id]);
  const answer = await due(BOB);
  expect(answer.tasks).toEqual([]);
});

const DEADLINE_MS = 5_000;

// The boards that answer do so in microtasks, so the clock moves only once they have.
async function waited<Answer>(
  asking: Promise<Answer>,
): Promise<{ answer: Answer; afterMs: number }> {
  let answer: { value: Answer } | null = null;
  void asking.then((value) => {
    answer = { value };
  });
  let afterMs = 0;
  for (;;) {
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    if (answer) return { answer: (answer as { value: Answer }).value, afterMs };
    if (afterMs > 60_000) throw new Error("It never answered.");
    jest.advanceTimersByTime(1_000);
    afterMs += 1_000;
  }
}

test("a board that doesn't answer in 5 seconds is counted, and the rest still show", async () => {
  await add("On Marketing", date("2026-11-12"), { assignee: ALICE });
  await add("On Product", date("2026-11-12"), { assignee: ALICE }, PRODUCT);
  jest.useFakeTimers();
  setSystemTime(NOW);
  const { answer, afterMs } = await waited(
    due(ALICE, OVERVIEW, async (boardId) => {
      const board = await kit.as(ALICE, boardId);
      return boardId === PRODUCT
        ? { ...board, listMyTasksDue: () => new Promise<never>(() => {}) }
        : board;
    }),
  );
  expect(afterMs).toBe(DEADLINE_MS);
  expect(titlesOf(answer)).toEqual(["On Marketing"]);
  expect(answer.unreachable).toBe(1);
});
