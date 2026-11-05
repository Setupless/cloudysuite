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
import type { Delivery } from "./invitations";
import type {
  CalendarEntry,
  CalendarOccurrence,
  CivilDate,
  EventDraft,
  EventTime,
  Organiser,
  TimeZone,
} from "./types";
import { actionsFor } from "./ui/event-form";

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
    people: [],
    ...more,
  }) satisfies EventDraft;

// What the card and panel offer, from what the server functions sent this person.
export function actionsSeen(
  occurrence: CalendarOccurrence,
  calendars: CalendarEntry[],
) {
  const calendar = calendars.find(
    (entry) => entry.id === occurrence.calendarId,
  );
  if (!calendar) throw new Error("expected the event's calendar");
  return actionsFor({ ...occurrence, calendar }, calendars);
}

// The real Calendar class on bun:sqlite, against a D1 built from the real migrations.
// This proves the logic and the SQL, not the Workers runtime.
export async function createCalendarTest() {
  const { sqlite: directory, d1 } = createTestDatabase();
  const objects = new Map<
    string,
    {
      sqlite: Database;
      object: InstanceType<typeof Calendar>;
      alarm: number | null;
    }
  >();
  // Calendars that another calendar can't reach, as if the call between them failed.
  const unreachable = new Set<string>();
  // Every invitation one object handed another, as it crossed between them.
  const delivered: { to: string; delivery: Delivery }[] = [];
  const env = {
    DB: d1,
    CALENDAR: {
      idFromName: (name: string) => name,
      get: (name: string) =>
        new Proxy(instanceOf(name).object, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            if (
              unreachable.has(name) &&
              (property === "receiveInvitation" || property === "receiveAnswer")
            ) {
              return () => Promise.reject(new Error("Calendar unreachable"));
            }
            if (property !== "receiveInvitation") return value.bind(target);
            return (delivery: Delivery) => {
              delivered.push({ to: name, delivery: structuredClone(delivery) });
              return value.call(target, structuredClone(delivery));
            };
          },
        }),
    },
  } as unknown as Env;

  function instanceOf(name: string) {
    const existing = objects.get(name);
    if (existing) return existing;
    const { db, sqlite } = createSqlDriver();
    const instance = { sqlite, alarm: null as number | null } as {
      sqlite: Database;
      object: InstanceType<typeof Calendar>;
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
    instance.object = new Calendar(ctx as unknown as DurableObjectState, env);
    objects.set(name, instance);
    return instance;
  }

  // Runs every alarm that is due, in every calendar, until none is, as the runtime would.
  async function settle() {
    for (let round = 0; round < 20; round++) {
      const due = [...objects.values()].filter(
        (instance) => instance.alarm !== null && instance.alarm <= Date.now(),
      );
      if (due.length === 0) return;
      for (const instance of due) {
        instance.alarm = null;
        await instance.object.alarm();
      }
    }
    throw new Error("the alarms never settled");
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
    settle,
    unreachable,
    delivered,
    // Hands a delivery to a calendar again, as a retry or a late copy would.
    deliverAgain: (to: string, delivery: Delivery) =>
      instanceOf(to).object.receiveInvitation(structuredClone(delivery)),
    alarmOf: (calendarId: CalendarId) => instanceOf(calendarId).alarm,
    sqlite: (calendarId: CalendarId = TEAM) => instanceOf(calendarId).sqlite,
  };
}
