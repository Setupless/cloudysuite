import { mock } from "bun:test";
import {
  type BoardId,
  type BoardRole,
  ensurePersonalBoard,
  type UserId,
} from "@cloudysuite/access";
import { createFakeEmail } from "@cloudysuite/app-email/test-support";
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
// The raw message the Board object hands the EMAIL binding.
mock.module("cloudflare:email", () => ({
  EmailMessage: class {
    constructor(
      readonly from: string,
      readonly to: string,
      readonly raw: string,
    ) {}
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
export const PRODUCT = "2c4a5f41-bd3e-4a01-8f88-3d4e5f607182" as BoardId;

// How a board's object answers another board, as if the network or the object failed.
// "silent" fails before the call does anything, and "loseAnswer" after it has done it.
export type Fault = "silent" | "loseAnswer";

export type BoardCall = { method: string; args: unknown[] };

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
  const faults = new Map<string, Map<string, Fault>>();
  const calls = new Map<string, BoardCall[]>();
  const email = createFakeEmail();
  // Records every call that reaches an object through the binding, and applies faults.
  function reach(name: string) {
    const object = instanceOf(name).object;
    return new Proxy(object, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function" || typeof property !== "string") {
          return value;
        }
        return async (...args: unknown[]) => {
          const fault = faults.get(name)?.get(property);
          if (fault === "silent") throw new Error(`${name} is silent`);
          const result = await value.apply(target, args);
          calls.set(name, [
            ...(calls.get(name) ?? []),
            { method: property, args: structuredClone(args) },
          ]);
          if (fault === "loseAnswer")
            throw new Error(`${name}'s answer was lost`);
          return result;
        };
      },
    });
  }
  const env = {
    DB: d1,
    EMAIL: email.binding,
    BOARD: {
      idFromName: (name: string) => name,
      get: reach,
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
        sync: async () => {},
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

  function join(person: Person, role: BoardRole, boardId = MARKETING) {
    directory.run(
      "INSERT INTO board_access (board_id, user_id, role) VALUES (?, ?, ?)",
      [boardId, person.id, role],
    );
  }
  join(ALICE, "manager");
  directory.run(
    "INSERT INTO boards (id, kind, name, colour) VALUES (?, 'team', 'Product', 3)",
    [PRODUCT],
  );
  directory.run(
    "INSERT INTO board_access (board_id, user_id, role) VALUES (?, ?, 'manager')",
    [PRODUCT, ALICE.id],
  );

  async function as(person: Person, boardId: BoardId = MARKETING) {
    const board = await openBoardAs(env, person.id, boardId);
    if (!board) throw new Error("expected access");
    return board;
  }

  return {
    env,
    d1,
    email,
    directory,
    join,
    as,
    personalBoardOf: (person: Person) => ensurePersonalBoard(d1, person.id),
    alarmOf: (boardId: BoardId) => instanceOf(boardId).alarm,
    // The object itself, for calls only another board's object makes.
    objectOf: (boardId: BoardId) => instanceOf(boardId).object,
    fail(boardId: BoardId, method: string, fault: Fault | null) {
      const board = faults.get(boardId) ?? new Map<string, Fault>();
      if (fault) board.set(method, fault);
      else board.delete(method);
      faults.set(boardId, board);
    },
    callsTo: (boardId: BoardId, method: string) =>
      (calls.get(boardId) ?? []).filter((call) => call.method === method),
    // Runs a board's alarm as the runtime would, once it's due.
    runAlarm: async (boardId: BoardId) => {
      const instance = instanceOf(boardId);
      instance.alarm = null;
      await instance.object.alarm();
    },
  };
}
