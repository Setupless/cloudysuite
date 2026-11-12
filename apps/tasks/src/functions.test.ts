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
import {
  createBoardTest,
  date,
  MARKETING,
  newTaskId,
  PRODUCT,
} from "./test-support";
import {
  ALREADY_THERE_MESSAGE,
  LAST_MANAGER_MESSAGE,
  NO_ACCESS_MESSAGE,
  NOT_ON_BOARD_MESSAGE,
  NO_PERSON_MESSAGE,
  ONLY_MANAGERS_MESSAGE,
  PRIVATE_BOARD_MESSAGE,
  REFUSAL_MESSAGES,
  type SettingsChange,
  refusedThereMessage,
  type TaskChangeInput,
  viewOnlyThereMessage,
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
let boards: ReturnType<typeof createBoardTest>;

beforeEach(async () => {
  kit = await createKit();
  boards = createBoardTest();
  unreachable.clear();
  env.DB = kit.database;
  // A move's receiver checks the mover again, in the same directory.
  (boards.env as unknown as Record<string, unknown>).DB = kit.database;
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
    () => as(people.outsider).boardSettings({ data: { boardId: MARKETING } }),
    () => as(people.outsider).countBoardTasks({ data: { boardId: MARKETING } }),
    () =>
      as(people.outsider).changeBoardSettings({
        data: { boardId: MARKETING, change: { kind: "leave" } },
      }),
    () =>
      as(people.outsider).addAndAssign({
        data: { boardId: MARKETING, taskId: task.id, userId: people.outsider },
      }),
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

test("a suspended member stays on the board's list, so a manager can remove them, but can't be assigned", async () => {
  kit.sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [people.viewer]);
  const settings = await as(people.manager).boardSettings({
    data: { boardId: MARKETING },
  });
  expect(
    settings.members.map((member) => [member.name, member.suspended]),
  ).toEqual([
    ["Boss", false],
    ["editor", false],
    ["viewer", true],
  ]);
  const task = await taskOf(create(people.editor));
  expect(
    await refused(
      change(people.editor, {
        kind: "assign",
        id: task.id,
        assigneeId: people.viewer,
      }),
    ),
  ).toEqual({ status: 400, message: NOT_ON_BOARD_MESSAGE });
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

test("search finds tasks on my boards, says what to type for odd text, and refuses a person who isn't there", async () => {
  await create(people.manager, { title: "Send the brochure" });
  await as(people.outsider).createPrivateTask({
    data: { id: newTaskId(), title: "Brochure for me", due: null },
  });
  const found = await as(people.viewer).searchTasks({
    data: { text: "brochure", boardId: MARKETING },
  });
  if (found.status !== "found") throw new Error("expected results");
  expect(found.tasks.map((task) => task.title)).toEqual(["Send the brochure"]);
  expect(found.people.kind).toBe("board");
  expect(
    await as(people.viewer).searchTasks({
      data: { text: "%*", boardId: null },
    }),
  ).toEqual({
    status: "problem",
    problem: "Type a word from a task, or someone's name.",
  });
  expect(
    await refused(
      as(people.viewer).listPersonTasks({
        data: { userId: "user-nobody" as UserId },
      }),
    ),
  ).toEqual({ status: 404, message: NO_PERSON_MESSAGE });
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

test("everyone on a board sees who else is on it, in the order they joined", async () => {
  const settings = await as(people.viewer).boardSettings({
    data: { boardId: MARKETING },
  });
  expect(settings.board).toEqual({
    id: MARKETING,
    name: "Marketing",
    colour: 2,
  });
  expect(settings.myRole).toBe("viewer");
  expect(settings.members.map((member) => [member.name, member.role])).toEqual([
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
    () => as(people.editor).boardSettings({ data: { boardId: MARKETING } }),
    () => as(people.editor).listColleagues(),
    () => as(people.editor).countBoardTasks({ data: { boardId: MARKETING } }),
    () =>
      as(people.editor).changeBoardSettings({
        data: { boardId: MARKETING, change: { kind: "leave" } },
      }),
    () =>
      as(people.editor).addAndAssign({
        data: { boardId: MARKETING, taskId: task.id, userId: people.editor },
      }),
    () => change(people.editor, { kind: "delete", id: task.id }),
    () =>
      as(people.editor).createPrivateTask({
        data: { id: newTaskId(), title: "x", due: null },
      }),
    () => as(people.editor).createTeamBoard({ data: { name: "Product" } }),
    () =>
      as(people.editor).moveTask({
        data: { boardId: MARKETING, taskId: task.id, to: "private" },
      }),
    () =>
      as(people.editor).searchTasks({
        data: { text: "newsletter", boardId: null },
      }),
    () =>
      as(people.editor).listPersonTasks({ data: { userId: people.viewer } }),
    () =>
      as(people.editor).assignmentEmail({
        data: { boardId: MARKETING, taskId: task.id },
      }),
    () =>
      as(people.editor).retryAssignmentEmail({
        data: { boardId: MARKETING, taskId: task.id },
      }),
    () => as(people.editor).listMoveNotices(),
    () =>
      as(people.editor).dismissMoveNotice({
        data: { boardId: MARKETING, moveId: crypto.randomUUID() },
      }),
  ];
  for (const call of calls) {
    const refusal = await refused(call());
    expect(refusal.status).toBe(403);
    expect(refusal.message).toContain("An admin turned Tasks off.");
  }
  expect(Object.keys(functions).sort()).toEqual([
    "addAndAssign",
    "assignmentEmail",
    "boardSettings",
    "changeBoardSettings",
    "changeTask",
    "countBoardTasks",
    "createPrivateTask",
    "createTeamBoard",
    "dismissMoveNotice",
    "listBoardTasks",
    "listColleagues",
    "listMoveNotices",
    "listMyBoards",
    "listMyTasks",
    "listPersonTasks",
    "moveTask",
    "retryAssignmentEmail",
    "searchTasks",
  ]);
});

const settle = (
  userId: UserId,
  settingsChange: SettingsChange,
  boardId: BoardId = MARKETING,
) =>
  as(userId).changeBoardSettings({
    data: { boardId, change: settingsChange },
  });

const rolesOn = (): Record<string, string> =>
  Object.fromEntries(
    (
      kit.rows(
        `SELECT user_id, role FROM board_access WHERE board_id = '${MARKETING}'`,
      ) as { user_id: string; role: string }[]
    ).map((row) => [row.user_id, row.role]),
  );

const managers = () =>
  Object.entries(rolesOn()).flatMap(([userId, role]) =>
    role === "manager" ? [userId as UserId] : [],
  );

test("only a manager adds people, takes them off, changes what they can do, or changes the board", async () => {
  const before = rolesOn();
  for (const who of [people.editor, people.viewer]) {
    for (const attempt of [
      { kind: "add", userId: people.outsider, role: "editor" },
      { kind: "setRole", userId: people.viewer, role: "manager" },
      { kind: "remove", userId: people.manager },
      { kind: "rename", name: "Mine now" },
      { kind: "setColour", colour: 5 },
      { kind: "delete" },
    ] satisfies SettingsChange[]) {
      expect(await refused(settle(who, attempt))).toEqual({
        status: 403,
        message: ONLY_MANAGERS_MESSAGE,
      });
    }
  }
  expect(rolesOn()).toEqual(before);
  expect((await as(people.editor).listMyBoards())[0]).toMatchObject({
    name: "Marketing",
    colour: 2,
  });

  await settle(people.manager, {
    kind: "add",
    userId: people.outsider,
    role: "viewer",
  });
  await settle(people.manager, {
    kind: "add",
    userId: people.outsider,
    role: "manager",
  });
  expect(rolesOn()[people.outsider]).toBe("viewer");
  await settle(people.manager, {
    kind: "setRole",
    userId: people.outsider,
    role: "editor",
  });
  expect(rolesOn()[people.outsider]).toBe("editor");
  await settle(people.manager, { kind: "remove", userId: people.outsider });
  expect(rolesOn()[people.outsider]).toBeUndefined();

  await settle(people.manager, { kind: "rename", name: "  Launch  " });
  await settle(people.manager, { kind: "setColour", colour: 5 });
  expect((await as(people.viewer).listMyBoards())[0]).toMatchObject({
    name: "Launch",
    colour: 5,
  });
});

test("the last manager can't leave or step down, even when two managers step down at once", async () => {
  for (const attempt of [
    settle(people.manager, { kind: "leave" }),
    settle(people.manager, {
      kind: "setRole",
      userId: people.manager,
      role: "editor",
    }),
  ]) {
    expect(await refused(attempt)).toEqual({
      status: 409,
      message: LAST_MANAGER_MESSAGE,
    });
  }

  await settle(people.manager, {
    kind: "setRole",
    userId: people.editor,
    role: "manager",
  });
  const stepDowns = await Promise.allSettled(
    [people.manager, people.editor].map((userId) =>
      settle(userId, { kind: "setRole", userId, role: "viewer" }),
    ),
  );
  expect(stepDowns.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(managers()).toHaveLength(1);

  await settle(people.viewer, { kind: "leave" });
  expect(rolesOn()[people.viewer]).toBeUndefined();
  const [lastManager] = managers() as [UserId];
  const other = lastManager === people.manager ? people.editor : people.manager;
  await settle(lastManager, {
    kind: "setRole",
    userId: other,
    role: "manager",
  });
  const leavings = await Promise.allSettled(
    [lastManager, other].map((userId) => settle(userId, { kind: "leave" })),
  );
  expect(leavings.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(managers()).toHaveLength(1);
});

test("a manager adds someone from the organisation as they assign them, and doing it again changes nothing", async () => {
  const task = await taskOf(create(people.editor));
  const assignOutsider = () =>
    as(people.manager).addAndAssign({
      data: { boardId: MARKETING, taskId: task.id, userId: people.outsider },
    });
  const first = await assignOutsider();
  expect(first.status === "done" && first.task.assignee).toEqual({
    id: people.outsider,
    name: "outsider",
  });
  expect(rolesOn()[people.outsider]).toBe("editor");

  const again = await assignOutsider();
  expect(again).toEqual(first);
  expect(
    kit.rows(
      `SELECT role FROM board_access WHERE user_id = '${people.outsider}'`,
    ),
  ).toEqual([{ role: "editor" }]);
  const mine = await as(people.outsider).listMyTasks();
  expect(mine.tasks.map((shown) => shown.id)).toEqual([task.id]);
});

test("adding someone while assigning keeps the role of someone already on the board", async () => {
  const task = await taskOf(create(people.editor));
  const given = await as(people.manager).addAndAssign({
    data: { boardId: MARKETING, taskId: task.id, userId: people.viewer },
  });
  expect(given.status === "done" && given.task.assignee?.id).toBe(
    people.viewer,
  );
  expect(rolesOn()[people.viewer]).toBe("viewer");
});

test("someone with Can edit can't add a person while assigning", async () => {
  const task = await taskOf(create(people.editor));
  expect(
    await refused(
      as(people.editor).addAndAssign({
        data: { boardId: MARKETING, taskId: task.id, userId: people.outsider },
      }),
    ),
  ).toEqual({ status: 403, message: ONLY_MANAGERS_MESSAGE });
  expect(rolesOn()[people.outsider]).toBeUndefined();
  const [shown] = (
    await as(people.editor).listBoardTasks({ data: { boardId: MARKETING } })
  ).tasks;
  expect(shown?.assignee).toBeNull();
});

test("deleting a board deletes its tasks, and asking again changes nothing", async () => {
  await create(people.editor, { assigneeId: people.editor });
  await create(people.editor);
  expect(
    await as(people.manager).countBoardTasks({ data: { boardId: MARKETING } }),
  ).toBe(2);

  await settle(people.manager, { kind: "delete" });
  expect(kit.rows("SELECT id FROM boards WHERE kind = 'team'")).toEqual([]);
  expect(kit.rows("SELECT * FROM board_access")).toEqual([]);
  expect(await as(people.editor).listMyBoards()).toEqual([]);
  expect((await as(people.editor).listMyTasks()).tasks).toEqual([]);
  expect(await refused(settle(people.manager, { kind: "delete" }))).toEqual({
    status: 403,
    message: NO_ACCESS_MESSAGE,
  });

  // The object is reached by the board's id, so a board brought back under the same id
  // shows whether anything was left behind.
  kit.sqlite.run(
    "INSERT INTO boards (id, kind, name, colour) VALUES (?, 'team', 'Marketing', 2)",
    [MARKETING],
  );
  kit.sqlite.run(
    "INSERT INTO board_access (board_id, user_id, role) VALUES (?, ?, 'manager')",
    [MARKETING, people.manager],
  );
  expect(
    (await as(people.manager).listBoardTasks({ data: { boardId: MARKETING } }))
      .tasks,
  ).toEqual([]);
});

const marketingInD1 = () =>
  kit.rows(`SELECT id FROM boards WHERE id = '${MARKETING}'`).length > 0;

// Read straight from the object, since D1 no longer lets anyone reach it.
const leftInMarketing = () =>
  boards.objectOf(MARKETING).listTasks({
    userId: people.manager,
    boardId: MARKETING,
    role: "manager",
    kind: "team",
  });

for (const fault of ["silent", "loseAnswer"] as const) {
  test(`a delete whose board object fails (${fault}) leaves the board listed, and deleting again finishes it`, async () => {
    await create(people.editor);
    boards.fail(MARKETING, "erase", fault);
    await expect(settle(people.manager, { kind: "delete" })).rejects.toThrow();
    expect(marketingInD1()).toBe(true);
    expect(await as(people.editor).listMyBoards()).toHaveLength(1);

    boards.fail(MARKETING, "erase", null);
    await settle(people.manager, { kind: "delete" });
    expect(marketingInD1()).toBe(false);
    expect(kit.rows("SELECT * FROM board_access")).toEqual([]);
    expect(leftInMarketing()).toEqual([]);
  });
}

test("a delete whose D1 step fails leaves a board that refuses every change, and deleting again finishes it", async () => {
  const task = await taskOf(create(people.editor));
  const privateTask = await as(people.editor).createPrivateTask({
    data: { id: newTaskId(), title: "Only mine", due: null },
  });
  kit.sqlite.run(
    `CREATE TRIGGER d1_fails BEFORE DELETE ON boards
     BEGIN SELECT RAISE(ABORT, 'D1 is unreachable'); END`,
  );
  await expect(settle(people.manager, { kind: "delete" })).rejects.toThrow();
  expect(marketingInD1()).toBe(true);
  expect(
    (await as(people.editor).listBoardTasks({ data: { boardId: MARKETING } }))
      .tasks,
  ).toEqual([]);
  // As from a page still open from before the delete.
  const gone = { status: 404, message: REFUSAL_MESSAGES.boardGone };
  expect(await refused(create(people.editor))).toEqual(gone);
  expect(
    await refused(
      change(people.editor, { kind: "rename", id: task.id, title: "Again" }),
    ),
  ).toEqual(gone);
  expect(
    await refused(change(people.editor, { kind: "undoDelete", id: task.id })),
  ).toEqual(gone);
  expect(
    await refused(
      moveTask(people.editor, privateTask.id, privateTask.board.id, MARKETING),
    ),
  ).toEqual({
    status: 409,
    message: refusedThereMessage("noAccess", "Marketing"),
  });
  expect(await titlesOn(people.editor, privateTask.board.id)).toEqual([
    { title: "Only mine", assignee: null },
  ]);

  kit.sqlite.run("DROP TRIGGER d1_fails");
  await settle(people.manager, { kind: "delete" });
  expect(marketingInD1()).toBe(false);
  expect(
    kit.rows(`SELECT * FROM board_access WHERE board_id = '${MARKETING}'`),
  ).toEqual([]);
  expect(leftInMarketing()).toEqual([]);
});

test("someone taken off a board loses it from My tasks, and their tasks there keep their name", async () => {
  const task = await taskOf(
    create(people.manager, { assigneeId: people.editor }),
  );
  expect((await as(people.editor).listMyTasks()).tasks).toHaveLength(1);

  await settle(people.manager, { kind: "remove", userId: people.editor });
  expect((await as(people.editor).listMyTasks()).tasks).toEqual([]);
  expect(await as(people.editor).listMyBoards()).toEqual([]);
  const [kept] = (
    await as(people.manager).listBoardTasks({ data: { boardId: MARKETING } })
  ).tasks;
  expect(kept?.assignee).toEqual({ id: people.editor, name: "editor" });
  const settings = await as(people.manager).boardSettings({
    data: { boardId: MARKETING },
  });
  expect(settings.members.map((member) => member.id)).not.toContain(
    people.editor,
  );

  const reassigned = await change(people.manager, {
    kind: "assign",
    id: task.id,
    assigneeId: people.viewer,
  });
  expect(reassigned.status === "done" && reassigned.task.assignee?.id).toBe(
    people.viewer,
  );
});

test("a person's own board has no settings", async () => {
  const task = await as(people.editor).createPrivateTask({
    data: { id: newTaskId(), title: "Only mine", due: null },
  });
  for (const attempt of [
    () => as(people.editor).boardSettings({ data: { boardId: task.board.id } }),
    () => settle(people.editor, { kind: "leave" }, task.board.id),
    () => settle(people.editor, { kind: "delete" }, task.board.id),
    () =>
      as(people.editor).addAndAssign({
        data: {
          boardId: task.board.id,
          taskId: task.id,
          userId: people.outsider,
        },
      }),
  ]) {
    expect(await refused(attempt())).toEqual({
      status: 403,
      message: PRIVATE_BOARD_MESSAGE,
    });
  }
});

function addProduct(roles: Partial<Record<BoardRole | "outsider", BoardRole>>) {
  kit.sqlite.run(
    "INSERT INTO boards (id, kind, name, colour) VALUES (?, 'team', 'Product', 3)",
    [PRODUCT],
  );
  for (const [who, role] of Object.entries(roles)) {
    kit.sqlite.run(
      "INSERT INTO board_access (board_id, user_id, role) VALUES (?, ?, ?)",
      [PRODUCT, people[who as BoardRole], role],
    );
  }
}

const moveTask = (
  userId: UserId,
  taskId: string,
  from: BoardId,
  to: BoardId | "private",
) => as(userId).moveTask({ data: { boardId: from, taskId, to } });

const titlesOn = async (userId: UserId, boardId: BoardId) =>
  (await as(userId).listBoardTasks({ data: { boardId } })).tasks.map(
    (task) => ({ title: task.title, assignee: task.assignee?.id ?? null }),
  );

test("a private task moved to a team board leaves one task, there, with nobody assigned", async () => {
  const task = await as(people.editor).createPrivateTask({
    data: { id: newTaskId(), title: "Draft the plan", due: null },
  });
  expect(
    await moveTask(people.editor, task.id, task.board.id, MARKETING),
  ).toEqual({
    status: "moved",
    to: { id: MARKETING, kind: "team", name: "Marketing", colour: 2 },
  });
  expect(await titlesOn(people.editor, task.board.id)).toEqual([]);
  expect(await titlesOn(people.editor, MARKETING)).toEqual([
    { title: "Draft the plan", assignee: null },
  ]);
});

test("a task moves to the person's private tasks, which the move makes, and back", async () => {
  const task = await taskOf(create(people.editor));
  const there = await moveTask(people.editor, task.id, MARKETING, "private");
  expect(there.status).toBe("moved");
  expect(there.to.kind).toBe("personal");
  expect(await titlesOn(people.editor, MARKETING)).toEqual([]);
  expect(await titlesOn(people.editor, there.to.id)).toHaveLength(1);
  expect(
    (await moveTask(people.editor, task.id, there.to.id, MARKETING)).status,
  ).toBe("moved");
  expect(await titlesOn(people.editor, there.to.id)).toEqual([]);
  expect(await titlesOn(people.editor, MARKETING)).toHaveLength(1);
});

test("Can view on either board refuses the move, and the task stays", async () => {
  addProduct({ editor: "viewer", viewer: "editor" });
  const task = await taskOf(create(people.editor));
  expect(
    await refused(moveTask(people.viewer, task.id, MARKETING, PRODUCT)),
  ).toEqual({ status: 403, message: REFUSAL_MESSAGES.noAccess });
  expect(
    await refused(moveTask(people.editor, task.id, MARKETING, PRODUCT)),
  ).toEqual({ status: 403, message: viewOnlyThereMessage("Product") });
  expect(
    await refused(moveTask(people.editor, task.id, MARKETING, MARKETING)),
  ).toEqual({ status: 409, message: ALREADY_THERE_MESSAGE });
  expect(
    await refused(moveTask(people.outsider, task.id, MARKETING, "private")),
  ).toEqual({ status: 403, message: NO_ACCESS_MESSAGE });
  expect(await titlesOn(people.editor, MARKETING)).toHaveLength(1);
});

test("an assignee on the receiving board stays assigned, and one who isn't arrives as nobody", async () => {
  addProduct({ manager: "manager", editor: "viewer" });
  const kept = await taskOf(
    create(people.manager, { assigneeId: people.editor }),
  );
  const left = await taskOf(
    create(people.manager, { title: "Other", assigneeId: people.viewer }),
  );
  for (const task of [kept, left]) {
    expect(
      (await moveTask(people.manager, task.id, MARKETING, PRODUCT)).status,
    ).toBe("moved");
  }
  expect(await titlesOn(people.manager, PRODUCT)).toEqual([
    { title: "Send the newsletter", assignee: people.editor },
    { title: "Other", assignee: null },
  ]);
});
