import { mock } from "bun:test";
import {
  type BoardId,
  type BoardRole,
  ensurePersonalBoard,
  type UserId,
} from "@cloudysuite/access";
import { createSqlDriver } from "@cloudysuite/object-sql/test-driver";
import {
  createTestDatabase,
  testWorkerEnv,
} from "../../../src/db/test-database";
import type { Person, PlainDate, TaskChange, TaskId } from "./types";

mock.module("cloudflare:workers", () => ({
  env: testWorkerEnv,
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
const { Board } = await import("./board");
const { openBoardAs } = await import("./client");

export const ALICE: Person = {
  id: "user-alice" as UserId,
  name: "Alice Stone",
};
export const BOB: Person = { id: "user-bob" as UserId, name: "Bob Lee" };
export const CAROL: Person = { id: "user-carol" as UserId, name: "Carol Diaz" };
export const MARKETING = "1b3f4e30-ac2d-4f90-9e77-2c3d4e5f6071" as BoardId;

let made = 0;
export const newTaskId = () =>
  `00000000-0000-4000-8000-${String(++made).padStart(12, "0")}` as TaskId;

export const create = (
  id: TaskId,
  more: Partial<Extract<TaskChange, { kind: "create" }>> = {},
): TaskChange => ({
  kind: "create",
  id,
  title: "Send the newsletter",
  due: null,
  assignee: null,
  creatorName: "Alice Stone",
  ...more,
});

export const date = (text: string) => text as PlainDate;

// The real Board class on bun:sqlite, against a D1 built from the real migrations, opened
// through the real access check. This proves the logic and the SQL, not the Workers
// runtime.
export function createBoardTest() {
  const { sqlite: directory, d1 } = createTestDatabase();
  const objects = new Map<
    string,
    { object: InstanceType<typeof Board>; alarm: number | null }
  >();
  const env = {
    DB: d1,
    BOARD: {
      idFromName: (name: string) => name,
      get: (name: string) => instanceOf(name).object,
    },
  } as unknown as Env;

  function instanceOf(name: string) {
    const existing = objects.get(name);
    if (existing) return existing;
    const { db } = createSqlDriver();
    const instance = { alarm: null } as {
      object: InstanceType<typeof Board>;
      alarm: number | null;
    };
    const ctx = {
      storage: {
        sql: { exec: db.exec },
        transactionSync: db.transaction,
        setAlarm: async (at: number) => {
          if (at <= 0) throw new Error("setAlarm() needs a time above 0");
          instance.alarm = at;
        },
        deleteAlarm: async () => {
          instance.alarm = null;
        },
      },
    };
    instance.object = new Board(ctx as unknown as DurableObjectState, env);
    objects.set(name, instance);
    return instance;
  }

  for (const person of [ALICE, BOB, CAROL]) {
    directory.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
      person.id,
      person.name,
      `${person.id}@example.com`,
    ]);
  }
  directory.run(
    "INSERT INTO boards (id, kind, name, colour) VALUES (?, 'team', 'Marketing', 2)",
    [MARKETING],
  );

  function join(person: Person, role: BoardRole) {
    directory.run(
      "INSERT INTO board_access (board_id, user_id, role) VALUES (?, ?, ?)",
      [MARKETING, person.id, role],
    );
  }
  join(ALICE, "manager");

  async function as(person: Person, boardId: BoardId = MARKETING) {
    const board = await openBoardAs(env, person.id, boardId);
    if (!board) throw new Error("expected access");
    return board;
  }

  return {
    env,
    d1,
    directory,
    join,
    as,
    personalBoardOf: (person: Person) => ensurePersonalBoard(d1, person.id),
    alarmOf: (boardId: BoardId) => instanceOf(boardId).alarm,
    // Runs a board's alarm as the runtime would, once it's due.
    runAlarm: async (boardId: BoardId) => {
      const instance = instanceOf(boardId);
      instance.alarm = null;
      await instance.object.alarm();
    },
  };
}
