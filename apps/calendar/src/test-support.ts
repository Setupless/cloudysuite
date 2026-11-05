import type { Database } from "bun:sqlite";
import { mock } from "bun:test";
import {
  type CalendarId,
  type CalendarRole,
  checkCalendarAccess,
  type UserId,
} from "@cloudysuite/access";
import { createSqlDriver } from "@cloudysuite/object-sql/test-driver";
import {
  createTestDatabase,
  testWorkerEnv,
} from "../../../src/db/test-database";
import type {
  CivilDate,
  EventDraft,
  EventTime,
  Organiser,
  TimeZone,
} from "./types";

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
const { Calendar } = await import("./calendar");
const { openCalendar } = await import("./client");

export const ALICE = "user-alice" as UserId;
export const BOB = "user-bob" as UserId;
export const CAROL = "user-carol" as UserId;
export const TEAM = "1b3f4e30-ac2d-4f90-9e77-2c3d4e5f6071" as CalendarId;

export const SYDNEY = "Australia/Sydney" as TimeZone;
export const LONDON = "Europe/London" as TimeZone;

export const date = (text: string) => text as CivilDate;

export const draft = (time: EventTime, more: Partial<EventDraft> = {}) =>
  ({
    title: "Team standup",
    location: "",
    notes: "",
    time,
    repeat: null,
    ...more,
  }) satisfies EventDraft;

// The real Calendar class on bun:sqlite, against a D1 built from the real migrations.
// This proves the logic and the SQL, not the Workers runtime.
export async function createCalendarTest() {
  const { sqlite: directory, d1 } = createTestDatabase();
  const objects = new Map<
    string,
    { sqlite: Database; object: InstanceType<typeof Calendar> }
  >();
  const env = {
    DB: d1,
    CALENDAR: {
      idFromName: (name: string) => name,
      get: (name: string) => instanceOf(name).object,
    },
  } as unknown as Env;

  function instanceOf(name: string) {
    const existing = objects.get(name);
    if (existing) return existing;
    const { db, sqlite } = createSqlDriver();
    const ctx = {
      storage: {
        sql: { exec: db.exec },
        transactionSync: db.transaction,
      },
    };
    const instance = {
      sqlite,
      object: new Calendar(ctx as unknown as DurableObjectState, env),
    };
    objects.set(name, instance);
    return instance;
  }

  for (const [id, name] of [
    [ALICE, "Alice Stone"],
    [BOB, "Bob Lee"],
    [CAROL, "Carol Diaz"],
  ] as const) {
    directory.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
      id,
      name,
      `${id}@example.com`,
    ]);
  }
  directory.run(
    "INSERT INTO calendars (id, kind, name, colour) VALUES (?, 'team', 'Marketing', 2)",
    [TEAM],
  );

  function join(userId: UserId, role: CalendarRole) {
    directory.run(
      "INSERT INTO calendar_access (calendar_id, user_id, role) VALUES (?, ?, ?)",
      [TEAM, userId, role],
    );
  }
  join(ALICE, "manager");

  async function as(userId: UserId, calendarId: CalendarId = TEAM) {
    const access = await checkCalendarAccess(d1, userId, calendarId);
    if (!access.allowed) throw new Error("expected access");
    return openCalendar(env, access.grant);
  }

  // Stands in for an invitation or an import, which later work brings in.
  function arrive(event: {
    uid: string;
    title: string;
    start: number;
    end: number;
    timeZone: TimeZone;
    rule: string | null;
    organiser: Organiser;
  }) {
    instanceOf(TEAM).sqlite.run(
      `INSERT INTO events (uid, title, location, notes, starts_at, ends_at, tzid, rrule,
         organiser, sequence, created_at, updated_at, span_start)
       VALUES (?, ?, '', '', ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
      [
        event.uid,
        event.title,
        event.start,
        event.end,
        event.timeZone,
        event.rule,
        JSON.stringify(event.organiser),
        event.start,
      ],
    );
  }

  return {
    env,
    d1,
    directory,
    join,
    as,
    arrive,
    sqlite: (calendarId: CalendarId = TEAM) => instanceOf(calendarId).sqlite,
  };
}
