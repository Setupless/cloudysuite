import {
  afterEach,
  beforeEach,
  expect,
  jest,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import type { BoardId, UserId } from "@cloudysuite/access";
import { inSearchOrder } from "./order";
import { type OpenBoard, searchBoards, tasksOfPerson } from "./search";
import { parseTaskSearch } from "./search-query";
import {
  ALICE,
  BOB,
  CAROL,
  create,
  createBoardTest,
  date,
  MARKETING,
  newTaskId,
  PRODUCT,
} from "./test-support";
import type {
  Person,
  PlainDate,
  SearchPlace,
  Task,
  TaskChange,
  TaskId,
} from "./types";

let kit: ReturnType<typeof createBoardTest>;
let quiet: ReturnType<typeof spyOn>;
const NOW = Date.parse("2026-11-12T09:00:00Z");
const MINE: SearchPlace = { kind: "mine" };
const ON_MARKETING: SearchPlace = { kind: "board", boardId: MARKETING };

beforeEach(() => {
  setSystemTime(NOW);
  kit = createBoardTest();
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

async function add(
  title: string,
  more: Partial<Extract<TaskChange, { kind: "create" }>> & {
    notes?: string;
    done?: boolean;
  } = {},
  boardId: BoardId = MARKETING,
): Promise<TaskId> {
  const { notes, done, ...creating } = more;
  const board = await kit.as(ALICE, boardId);
  const id = newTaskId();
  const result = await board.change(create(id, { title, ...creating }));
  if (result.status !== "done") throw new Error("expected a task");
  if (notes) await board.change({ kind: "setNotes", id, notes });
  if (done) await board.change({ kind: "setStatus", id, status: "done" });
  return id;
}

async function search(
  text: string,
  person: Person = ALICE,
  place: SearchPlace = MINE,
  open: OpenBoard = opener(person),
) {
  const parsed = parseTaskSearch(text);
  if (!parsed.ok) throw new Error(parsed.problem);
  return searchBoards(kit.d1, person, open, parsed.terms, place);
}

const titlesOf = (answer: { tasks: Task[] }) =>
  answer.tasks.map((task) => task.title);

test("each word must start a word of the title or notes, in any order, whatever the case or accents", async () => {
  await add("Plan the café opening");
  await add("Order chairs", { notes: "Ask Ben Hart about the Résumé" });
  await add("Something else");

  expect(titlesOf(await search("OPENING plan"))).toEqual([
    "Plan the café opening",
  ]);
  expect(titlesOf(await search("cafe"))).toEqual(["Plan the café opening"]);
  expect(titlesOf(await search("resume hart"))).toEqual(["Order chairs"]);
  expect(titlesOf(await search("har"))).toEqual(["Order chairs"]);
  expect(titlesOf(await search("art"))).toEqual([]);
  expect(titlesOf(await search("plan chairs"))).toEqual([]);
});

test("a renamed task is found by its new title only, and new notes are found", async () => {
  const id = await add("Draft the brochure");
  const board = await kit.as(ALICE);
  await board.change({ kind: "rename", id, title: "Print the flyer" });
  await board.change({ kind: "setNotes", id, notes: "Two hundred copies" });
  expect(titlesOf(await search("brochure"))).toEqual([]);
  expect(titlesOf(await search("flyer copies"))).toEqual(["Print the flyer"]);
});

test("open tasks come first, soonest due first and no date last, then done tasks, most recently done first", async () => {
  await add("Report no date");
  await add("Report later", { due: date("2026-11-20") });
  const doneFirst = await add("Report done first");
  await add("Report soon", { due: date("2026-11-13") }, PRODUCT);
  const board = await kit.as(ALICE);
  await board.change({ kind: "setStatus", id: doneFirst, status: "done" });
  setSystemTime(NOW + 60_000);
  await add("Report done last", { done: true }, PRODUCT);

  const answer = await search("report");
  expect(titlesOf(answer)).toEqual([
    "Report soon",
    "Report later",
    "Report no date",
    "Report done last",
    "Report done first",
  ]);
  expect(answer.tasks.map((task) => task.board.name)).toEqual([
    "Product",
    "Marketing",
    "Marketing",
    "Product",
    "Marketing",
  ]);
});

test("the order is one rule: open before done, by due date, then by when done", () => {
  const task = (title: string, more: Partial<Task>): Task => ({
    id: title as TaskId,
    title,
    status: "todo",
    assignee: null,
    due: null,
    notes: "",
    checklist: [],
    createdBy: ALICE,
    createdAt: 1,
    doneAt: null,
    moving: null,
    ...more,
  });
  const tasks = [
    task("done early", { status: "done", doneAt: 10 }),
    task("no date", {}),
    task("doing soon", { status: "doing", due: "2026-11-13" as PlainDate }),
    task("done late", {
      status: "done",
      doneAt: 20,
      due: "2026-11-01" as PlainDate,
    }),
    task("today", { due: "2026-11-12" as PlainDate }),
  ];
  expect(tasks.sort(inSearchOrder).map((one) => one.title)).toEqual([
    "today",
    "doing soon",
    "no date",
    "done late",
    "done early",
  ]);
});

test("private tasks and done tasks are found, and deleted tasks and tasks moving out aren't", async () => {
  const own = await kit.personalBoardOf(ALICE);
  await add("Invoice for me", {}, own);
  await add("Invoice paid", { done: true });
  const deleted = await add("Invoice deleted");
  const moving = await add("Invoice moving");
  const board = await kit.as(ALICE);
  await board.change({ kind: "delete", id: deleted });
  kit.fail(PRODUCT, "receiveMove", "silent");
  expect(
    await board.moveTo(moving, await kit.as(ALICE, PRODUCT), {
      to: { kind: "team", name: "Product" },
      keepAssigneeId: null,
    }),
  ).toEqual({ status: "pending" });

  const answer = await search("invoice");
  expect(answer.tasks.map((task) => [task.title, task.board.kind])).toEqual([
    ["Invoice for me", "personal"],
    ["Invoice paid", "team"],
  ]);
  expect(answer.unreachable).toBe(0);
});

test("a board the person isn't on is never searched, and someone else's private tasks never show", async () => {
  kit.join(BOB, "viewer");
  await add("Launch on Marketing");
  await add("Launch on Product", {}, PRODUCT);
  const alicesOwn = await kit.personalBoardOf(ALICE);
  await add("Launch for Alice alone", {}, alicesOwn);
  const asked: BoardId[] = [];
  const answer = await search("launch", BOB, MINE, async (boardId) => {
    asked.push(boardId);
    return kit.as(BOB, boardId);
  });
  expect(titlesOf(answer)).toEqual(["Launch on Marketing"]);
  expect(asked).toEqual([MARKETING]);
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

test("a board that doesn't answer in 5 seconds is counted, and the rest still answer", async () => {
  await add("Budget on Marketing");
  await add("Budget on Product", {}, PRODUCT);
  jest.useFakeTimers();
  setSystemTime(NOW);
  const { answer, afterMs } = await waited(
    search("budget", ALICE, MINE, async (boardId) => {
      const board = await kit.as(ALICE, boardId);
      return boardId === PRODUCT
        ? { ...board, search: () => new Promise<never>(() => {}) }
        : board;
    }),
  );
  expect(afterMs).toBe(DEADLINE_MS);
  expect(titlesOf(answer)).toEqual(["Budget on Marketing"]);
  expect(answer.unreachable).toBe(1);
});

test("a board that fails is counted, and the rest still answer", async () => {
  await add("Budget on Marketing");
  await add("Budget on Product", {}, PRODUCT);
  kit.fail(PRODUCT, "searchTasks", "silent");
  const answer = await search("budget");
  expect(titlesOf(answer)).toEqual(["Budget on Marketing"]);
  expect(answer.unreachable).toBe(1);
});

test("odd text is only words, so nothing typed causes an error", async () => {
  await add(`Fix the "quote" 100% now*`);
  for (const text of ["", "   ", `"`, "%", "*", "-", "()", "^:"]) {
    const parsed = parseTaskSearch(text);
    expect([text, parsed.ok]).toEqual([text, false]);
  }
  for (const text of [
    `"quote`,
    "100%",
    "now*",
    `" OR "`,
    `fix" AND NOT "x`,
    "NEAR(fix)",
  ]) {
    expect(await search(text)).toMatchObject({ status: "found" });
  }
  expect(titlesOf(await search(`"quote`))).toEqual([
    `Fix the "quote" 100% now*`,
  ]);
  expect(parseTaskSearch("x".repeat(201))).toMatchObject({ ok: false });
});

const DAN: Person = { id: "user-dan" as UserId, name: "Dan Hartley" };
const ERIN: Person = { id: "user-erin" as UserId, name: "Erin Hart" };

function addPeople() {
  for (const person of [DAN, ERIN]) {
    kit.directory.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
      person.id,
      person.name,
      `${person.id}@example.com`,
    ]);
  }
}

const namesOf = (people: readonly { name: string }[]) =>
  people.map((person) => person.name);

test("on a board, its members come first, then others in the organisation, without anyone suspended", async () => {
  addPeople();
  kit.join(DAN, "viewer");
  kit.join(BOB, "editor");
  kit.directory.run("UPDATE user SET banned = 1 WHERE id = ?", [BOB.id]);

  const answer = await search("hart", ALICE, ON_MARKETING);
  expect(answer.people).toEqual({
    kind: "board",
    board: { id: MARKETING, name: "Marketing" },
    members: [{ id: DAN.id, name: DAN.name, email: `${DAN.id}@example.com` }],
    others: [{ id: ERIN.id, name: ERIN.name, email: `${ERIN.id}@example.com` }],
  });
  const all = await search("e", ALICE, ON_MARKETING);
  if (all.people.kind !== "board") throw new Error("expected the board");
  expect(namesOf(all.people.members)).toEqual([]);
  expect(namesOf(all.people.others)).toEqual(["Erin Hart"]);
  expect(
    namesOf((await search("lee", ALICE, ON_MARKETING)).people.others),
  ).toEqual([]);
});

test("on My tasks, the people I share a board with come first, then everyone else", async () => {
  addPeople();
  kit.join(DAN, "viewer", PRODUCT);
  const answer = await search("hart");
  expect(answer.people.kind).toBe("mine");
  if (answer.people.kind !== "mine") return;
  expect(namesOf(answer.people.shared)).toEqual(["Dan Hartley"]);
  expect(namesOf(answer.people.others)).toEqual(["Erin Hart"]);
});

test("a person's result holds their name and address and nothing about their tasks", async () => {
  addPeople();
  kit.join(DAN, "editor");
  await add("Hart's work", { assignee: DAN });
  const answer = await search("hart", ALICE, ON_MARKETING);
  if (answer.people.kind !== "board") throw new Error("expected the board");
  for (const person of [...answer.people.members, ...answer.people.others]) {
    expect(Object.keys(person).sort()).toEqual(["email", "id", "name"]);
  }
});

test("a board search from a board the person isn't on falls back to My tasks' sections", async () => {
  addPeople();
  const answer = await search("hart", BOB, ON_MARKETING);
  expect(answer.people.kind).toBe("mine");
});

test("a person's tasks are their open tasks on the boards both people are on", async () => {
  addPeople();
  kit.join(DAN, "editor");
  kit.join(DAN, "editor", PRODUCT);
  kit.join(BOB, "viewer");
  await add("Dan's Marketing task", { assignee: DAN, due: date("2026-11-14") });
  await add("Dan's done task", { assignee: DAN, done: true });
  await add("Someone else's", { assignee: BOB });
  await add("Dan's Product task", { assignee: DAN }, PRODUCT);

  const forAlice = await tasksOfPerson(kit.d1, ALICE, opener(ALICE), {
    ...DAN,
    email: "",
  });
  expect(titlesOf(forAlice)).toEqual([
    "Dan's Marketing task",
    "Dan's Product task",
  ]);
  const forBob = await tasksOfPerson(kit.d1, BOB, opener(BOB), {
    ...DAN,
    email: "",
  });
  expect(titlesOf(forBob)).toEqual(["Dan's Marketing task"]);
  const forCarol = await tasksOfPerson(kit.d1, CAROL, opener(CAROL), {
    ...DAN,
    email: "",
  });
  expect(forCarol.tasks).toEqual([]);
});
