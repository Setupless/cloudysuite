import { beforeEach, expect, mock, test } from "bun:test";
import type { BoardId, BoardRole, UserId } from "@cloudysuite/access";
import * as start from "@tanstack/react-start";
import * as startServer from "@tanstack/react-start/server";
import { testWorkerEnv } from "../../../src/db/test-database";
import {
  createKit,
  type Kit,
  PASSWORD,
  signIn,
} from "../../auth/src/admin/test-kit";
import { createBoardTest, date, MARKETING, newTaskId } from "./test-support";
import {
  NO_ACCESS_MESSAGE,
  NOT_ON_BOARD_MESSAGE,
  REFUSAL_MESSAGES,
  type TaskChangeInput,
} from "./types";

// Outside Vite a server function never reaches its handler, so this runs the validator
// and handler as the compiled server function would.
type Handler = (context: { data?: unknown }) => unknown;
const createServerFn = () => ({
  validator: (parse: (raw: unknown) => unknown) => ({
    handler:
      (run: Handler) =>
      async ({ data }: { data: unknown }) =>
        run({ data: parse(data) }),
  }),
  handler: (run: Handler) => () => run({}),
});
let request: Request;
mock.module("@tanstack/react-start", () => ({ ...start, createServerFn }));
mock.module("@tanstack/react-start/server", () => ({
  ...startServer,
  getRequest: () => request,
}));
const functions = await import("./functions");

const env = testWorkerEnv as unknown as Record<string, unknown>;
let kit: Kit;
const cookies = new Map<UserId, string>();
const people = {} as Record<BoardRole | "outsider", UserId>;
// Boards that fail when asked, as if their object couldn't be reached.
const unreachable = new Set<string>();

beforeEach(async () => {
  kit = await createKit();
  const boards = createBoardTest();
  unreachable.clear();
  env.DB = kit.database;
  env.BOARD = {
    idFromName: (name: string) => name,
    get: (name: string) =>
      unreachable.has(name)
        ? { listMyTasks: () => Promise.reject(new Error("Board unreachable")) }
        : (boards.env.BOARD as DurableObjectNamespace).get(
            name as unknown as DurableObjectId,
          ),
  };
  env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
  people.manager = kit.admin;
  for (const name of ["editor", "viewer", "outsider"] as const) {
    const { user } = await kit.auth.api.createUser({
      body: { email: `${name}@example.com`, password: PASSWORD, name },
    });
    people[name] = user.id as UserId;
  }
  for (const [name, id] of Object.entries(people)) {
    const email = id === kit.admin ? "boss@example.com" : `${name}@example.com`;
    kit.sqlite.run("DELETE FROM rate_limit");
    const response = await signIn(kit, email);
    cookies.set(id, response.headers.get("set-cookie")!);
  }
  kit.sqlite.run(
    "INSERT INTO boards (id, kind, name, colour) VALUES (?, 'team', 'Marketing', 2)",
    [MARKETING],
  );
  for (const role of ["manager", "editor", "viewer"] as const) {
    kit.sqlite.run(
      "INSERT INTO board_access (board_id, user_id, role) VALUES (?, ?, ?)",
      [MARKETING, people[role], role],
    );
  }
});

function as(userId: UserId) {
  request = new Request("https://tasks.example.com/_serverFn/x", {
    method: "POST",
    headers: { cookie: cookies.get(userId)! },
  });
  return functions;
}

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    return {
      status: thrown.status,
      message: ((await thrown.json()) as { message: string }).message,
    };
  }
  throw new Error("expected a refusal");
}

const change = (
  userId: UserId,
  taskChange: TaskChangeInput,
  boardId: BoardId = MARKETING,
) => as(userId).changeTask({ data: { boardId, change: taskChange } });

const create = (
  userId: UserId,
  more: Partial<Extract<TaskChangeInput, { kind: "create" }>> = {},
) =>
  change(userId, {
    kind: "create",
    id: newTaskId(),
    title: "Send the newsletter",
    due: null,
    assigneeId: null,
    ...more,
  });

const taskOf = async (answer: ReturnType<typeof create>) => {
  const result = await answer;
  if (result.status !== "done") throw new Error("expected a task");
  return result.task;
};

test("someone not on a board is refused everything about it", async () => {
  const task = await taskOf(create(people.editor));
  for (const attempt of [
    () => as(people.outsider).listBoardTasks({ data: { boardId: MARKETING } }),
    () => as(people.outsider).boardMembers({ data: { boardId: MARKETING } }),
    () =>
      change(people.outsider, { kind: "rename", id: task.id, title: "Mine" }),
  ]) {
    expect(await refused(attempt())).toEqual({
      status: 403,
      message: NO_ACCESS_MESSAGE,
    });
  }
  expect(await as(people.outsider).listMyBoards()).toEqual([]);
});

test("Can view can't add a task, but can tick off one assigned to them", async () => {
  expect(await refused(create(people.viewer))).toEqual({
    status: 403,
    message: REFUSAL_MESSAGES.noAccess,
  });

  const theirs = await taskOf(
    create(people.editor, { assigneeId: people.viewer }),
  );
  const someoneElses = await taskOf(
    create(people.editor, { assigneeId: people.editor }),
  );
  const ticked = await change(people.viewer, {
    kind: "setStatus",
    id: theirs.id,
    status: "done",
  });
  expect(ticked.status === "done" && ticked.task.status).toBe("done");
  expect(
    await refused(
      change(people.viewer, {
        kind: "setStatus",
        id: someoneElses.id,
        status: "done",
      }),
    ),
  ).toEqual({ status: 403, message: REFUSAL_MESSAGES.noAccess });
  expect(
    await refused(
      change(people.viewer, { kind: "rename", id: theirs.id, title: "Mine" }),
    ),
  ).toEqual({ status: 403, message: REFUSAL_MESSAGES.noAccess });
});

test("only someone on the board can be assigned, under the name the directory holds", async () => {
  const task = await taskOf(create(people.editor));
  expect(
    await refused(
      change(people.editor, {
        kind: "assign",
        id: task.id,
        assigneeId: people.outsider,
      }),
    ),
  ).toEqual({ status: 400, message: NOT_ON_BOARD_MESSAGE });
  expect(
    await refused(create(people.editor, { assigneeId: people.outsider })),
  ).toEqual({ status: 400, message: NOT_ON_BOARD_MESSAGE });

  kit.sqlite.run("UPDATE user SET name = 'Vic Viewer' WHERE id = ?", [
    people.viewer,
  ]);
  const given = await change(people.editor, {
    kind: "assign",
    id: task.id,
    assigneeId: people.viewer,
  });
  expect(given.status === "done" && given.task.assignee).toEqual({
    id: people.viewer,
    name: "Vic Viewer",
  });
  const listed = await as(people.manager).listBoardTasks({
    data: { boardId: MARKETING },
  });
  expect(listed.tasks.map((shown) => shown.assignee?.name)).toEqual([
    "Vic Viewer",
  ]);
  expect(listed.tasks[0]?.createdBy.name).toBe("editor");
  expect(listed.role).toBe("manager");
});

test("My tasks holds my assigned and private tasks, not other people's, and counts a board that didn't answer", async () => {
  await create(people.manager, {
    title: "Mine on Marketing",
    assigneeId: people.editor,
    due: date("2026-11-13"),
  });
  await create(people.manager, {
    title: "Someone else's",
    assigneeId: people.viewer,
  });
  await create(people.manager, { title: "Nobody's yet" });
  await as(people.editor).createPrivateTask({
    data: { id: newTaskId(), title: "Only mine", due: null },
  });
  await as(people.viewer).createPrivateTask({
    data: { id: newTaskId(), title: "Only the viewer's", due: null },
  });

  const mine = await as(people.editor).listMyTasks();
  expect(mine.unreachable).toBe(0);
  expect(
    mine.tasks
      .map((task) => [task.title, task.board.kind, task.board.name])
      .sort(),
  ).toEqual([
    ["Mine on Marketing", "team", "Marketing"],
    ["Only mine", "personal", "editor"],
  ]);

  unreachable.add(MARKETING);
  const without = await as(people.editor).listMyTasks();
  expect(without.unreachable).toBe(1);
  expect(without.tasks.map((task) => task.title)).toEqual(["Only mine"]);
});

test("a task done today stays in My tasks, and one done long ago doesn't", async () => {
  const task = await taskOf(
    create(people.manager, { assigneeId: people.editor }),
  );
  await change(people.editor, {
    kind: "setStatus",
    id: task.id,
    status: "done",
  });
  const [shown] = (await as(people.editor).listMyTasks()).tasks;
  expect(shown?.status).toBe("done");

  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 24 * 60 * 60 * 1000;
  try {
    expect((await as(people.editor).listMyTasks()).tasks).toEqual([]);
  } finally {
    Date.now = realNow;
  }
});

test("looking at My tasks makes nothing, and two private tasks at once make one board", async () => {
  await as(people.editor).listMyTasks();
  expect(kit.count("boards")).toBe(1);

  const [first, second] = await Promise.all([
    as(people.editor).createPrivateTask({
      data: { id: newTaskId(), title: "First", due: null },
    }),
    as(people.editor).createPrivateTask({
      data: { id: newTaskId(), title: "Second", due: date("2026-11-20") },
    }),
  ]);
  expect(first.board.id).toBe(second.board.id);
  expect(
    kit.rows("SELECT kind FROM boards WHERE kind = 'personal'"),
  ).toHaveLength(1);
  expect(
    (await as(people.editor).listMyTasks()).tasks
      .map((task) => task.title)
      .sort(),
  ).toEqual(["First", "Second"]);
});

test("a private task can't be given to anyone", async () => {
  const task = await as(people.editor).createPrivateTask({
    data: { id: newTaskId(), title: "Only mine", due: null },
  });
  expect(
    await refused(
      change(
        people.editor,
        { kind: "assign", id: task.id, assigneeId: people.editor },
        task.board.id,
      ),
    ),
  ).toEqual({ status: 400, message: REFUSAL_MESSAGES.privateBoard });
});

test("a new team board takes the next team colour and makes its creator the manager", async () => {
  const boardId = await as(people.editor).createTeamBoard({
    data: { name: "  Product  " },
  });
  expect(await as(people.editor).listMyBoards()).toEqual([
    {
      id: MARKETING,
      kind: "team",
      name: "Marketing",
      colour: 2,
      role: "editor",
    },
    { id: boardId, kind: "team", name: "Product", colour: 2, role: "manager" },
  ]);
  expect(
    await refused(as(people.editor).createTeamBoard({ data: { name: "   " } })),
  ).toEqual({ status: 400, message: "Give the board a name." });
});

test("the members list holds everyone on the board, for the picker", async () => {
  const members = await as(people.viewer).boardMembers({
    data: { boardId: MARKETING },
  });
  expect(members.map((member) => [member.name, member.role])).toEqual([
    ["Boss", "manager"],
    ["editor", "editor"],
    ["viewer", "viewer"],
  ]);
});

test("a change that isn't one is refused in plain words", async () => {
  const task = await taskOf(create(people.editor));
  for (const bad of [
    { kind: "erase", id: task.id },
    { kind: "setStatus", id: task.id, status: "blocked" },
    { kind: "setDue", id: task.id, due: "2026-02-30" },
    { kind: "rename", id: "not-an-id", title: "x" },
  ]) {
    expect(
      await refused(
        as(people.editor).changeTask({
          data: { boardId: MARKETING, change: bad as TaskChangeInput },
        }),
      ),
    ).toEqual({ status: 400, message: "That request isn't valid." });
  }
  expect(
    await refused(
      as(people.editor).listBoardTasks({
        data: { boardId: "../other" as BoardId },
      }),
    ),
  ).toEqual({ status: 400, message: "That request isn't valid." });
});

test("with Tasks off, every function refuses in plain words", async () => {
  const task = await taskOf(create(people.editor));
  kit.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('tasks', 0)");
  const calls = [
    () => as(people.editor).listMyBoards(),
    () => as(people.editor).listMyTasks(),
    () => as(people.editor).listBoardTasks({ data: { boardId: MARKETING } }),
    () => as(people.editor).boardMembers({ data: { boardId: MARKETING } }),
    () => change(people.editor, { kind: "delete", id: task.id }),
    () =>
      as(people.editor).createPrivateTask({
        data: { id: newTaskId(), title: "x", due: null },
      }),
    () => as(people.editor).createTeamBoard({ data: { name: "Product" } }),
  ];
  for (const call of calls) {
    const refusal = await refused(call());
    expect(refusal.status).toBe(403);
    expect(refusal.message).toContain("An admin turned Tasks off.");
  }
  expect(Object.keys(functions).sort()).toEqual([
    "boardMembers",
    "changeTask",
    "createPrivateTask",
    "createTeamBoard",
    "listBoardTasks",
    "listMyBoards",
    "listMyTasks",
  ]);
});
