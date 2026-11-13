import { beforeEach, expect, setSystemTime, afterEach, test } from "bun:test";
import type { BoardId, UserId } from "@cloudysuite/access";
import { testWorkerEnv } from "../../../src/db/test-database";
import { readRequestFrom } from "../../../src/test-server-fn";
import {
  createKit,
  type Kit,
  PASSWORD,
  signIn,
} from "../../auth/src/admin/test-kit";
import {
  create,
  createBoardTest,
  date,
  MARKETING,
  newTaskId,
} from "../../tasks/src/test-support";
import type { Person, TaskId } from "../../tasks/src/types";

let request: Request;
readRequestFrom(() => request);
const { listDueTasks, setTaskStatus } = await import("./task-functions");

const env = testWorkerEnv as unknown as Record<string, unknown>;
const NOW = Date.parse("2026-11-12T09:00:00Z");
const OVERVIEW = { from: null, to: "2026-11-14" };
let kit: Kit;
let boards: ReturnType<typeof createBoardTest>;
const cookies = new Map<UserId, string>();
let viewer: Person;
let manager: Person;

beforeEach(async () => {
  kit = await createKit();
  boards = createBoardTest();
  env.DB = kit.database;
  env.BOARD = boards.env.BOARD;
  // The boards' own access check reads the same directory.
  (boards.env as unknown as Record<string, unknown>).DB = kit.database;
  env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
  manager = { id: kit.admin, name: "Boss" };
  const { user } = await kit.auth.api.createUser({
    body: { email: "viewer@example.com", password: PASSWORD, name: "Vic" },
  });
  viewer = { id: user.id as UserId, name: "Vic" };
  for (const [person, email] of [
    [manager, "boss@example.com"],
    [viewer, "viewer@example.com"],
  ] as const) {
    kit.sqlite.run("DELETE FROM rate_limit");
    cookies.set(
      person.id,
      (await signIn(kit, email)).headers.get("set-cookie")!,
    );
  }
  kit.sqlite.run(
    "INSERT INTO boards (id, kind, name, colour) VALUES (?, 'team', 'Marketing', 2)",
    [MARKETING],
  );
  kit.sqlite.run(
    "INSERT INTO board_access (board_id, user_id, role) VALUES (?, ?, 'manager'), (?, ?, 'viewer')",
    [MARKETING, manager.id, MARKETING, viewer.id],
  );
  setSystemTime(NOW);
});

afterEach(() => setSystemTime());

function as(person: Person, host = "calendar.example.com") {
  request = new Request(`https://${host}/_serverFn/x`, {
    method: "POST",
    headers: { cookie: cookies.get(person.id)! },
  });
  return { listDueTasks, setTaskStatus };
}

const turnOff = (app: string) =>
  kit.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES (?, 0)", [
    app,
  ]);

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

// Added straight on the board, as Tasks would.
async function add(title: string, assignee: Person | null) {
  const id = newTaskId();
  const board = await boards.as(manager, MARKETING);
  await board.change(create(id, { title, due: date("2026-11-12"), assignee }));
  return id;
}

const titles = async (person: Person) => {
  const answer = await as(person).listDueTasks({ data: OVERVIEW });
  if (answer.status !== "listed") throw new Error(answer.status);
  return answer.tasks.map((task) => task.title);
};

const tick = (
  person: Person,
  taskId: TaskId,
  status = "done",
  host = "calendar.example.com",
) =>
  as(person, host).setTaskStatus({
    data: { boardId: MARKETING as BoardId, taskId, status },
  });

test("Calendar lists only the person's own tasks, never a colleague's", async () => {
  await add("For Vic", viewer);
  await add("For the boss", manager);
  await add("For nobody", null);
  expect(await titles(viewer)).toEqual(["For Vic"]);
  expect(await titles(manager)).toEqual(["For the boss"]);
});

test("ticking marks the task done in Tasks, and Undo puts back what it was", async () => {
  const id = await add("Send the newsletter", manager);
  const board = await boards.as(manager, MARKETING);
  await board.change({ kind: "setStatus", id, status: "doing" });

  await tick(manager, id);
  expect((await board.findTask(id))?.status).toBe("done");
  expect(await titles(manager)).toEqual([]);

  await tick(manager, id, "doing");
  expect((await board.findTask(id))?.status).toBe("doing");
  expect(await titles(manager)).toEqual(["Send the newsletter"]);
});

test("Can view ticks off only their own tasks, as in Tasks", async () => {
  const theirs = await add("For Vic", viewer);
  const bosses = await add("For the boss", manager);
  await tick(viewer, theirs);
  expect(await refused(tick(viewer, bosses))).toEqual({
    status: 403,
    message:
      "You can view this board but not change it. Ask one of its managers for Can edit.",
  });
});

test("with Tasks off, the section has nothing to show and ticking is refused in plain words", async () => {
  const id = await add("Send the newsletter", manager);
  turnOff("tasks");
  expect(await as(manager).listDueTasks({ data: OVERVIEW })).toEqual({
    status: "off",
  });
  expect(await refused(tick(manager, id))).toEqual({
    status: 403,
    message:
      "An admin turned Tasks off, so tasks can't be changed here. Your tasks are safe, and they come back when it's turned on again.",
  });
  const board = await boards.as(manager, MARKETING);
  expect((await board.findTask(id))?.status).toBe("todo");
});

test.each(["calendar.example.com", "tasks.example.com"])(
  "with Calendar off, a call through %s is refused",
  async (host) => {
    const id = await add("Send the newsletter", manager);
    turnOff("calendar");
    const listing = await refused(
      as(manager, host).listDueTasks({ data: OVERVIEW }),
    );
    expect(listing.message).toContain("turned Calendar off");
    expect((await refused(tick(manager, id, "done", host))).message).toContain(
      "turned Calendar off",
    );
  },
);

test("a range longer than Schedule ever asks for is refused", async () => {
  expect(
    (
      await refused(
        as(manager).listDueTasks({
          data: { from: "2026-01-01", to: "2026-12-31" },
        }),
      )
    ).status,
  ).toBe(400);
});
