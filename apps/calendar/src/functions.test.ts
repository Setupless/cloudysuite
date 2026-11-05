import { beforeEach, expect, mock, test } from "bun:test";
import type { CalendarRole, UserId } from "@cloudysuite/access";
import * as start from "@tanstack/react-start";
import * as startServer from "@tanstack/react-start/server";
import { testWorkerEnv } from "../../../src/db/test-database";
import {
  createKit,
  type Kit,
  PASSWORD,
  signIn,
} from "../../auth/src/admin/test-kit";
import { createCalendarTest, SYDNEY, TEAM } from "./test-support";
import { ONLY_MANAGERS_MESSAGE } from "./types";

// Outside Vite a server function never reaches its handler, so this runs the validator
// and handler as the compiled server function would.
type Handler = (context: { data?: unknown }) => unknown;
const createServerFn = () => ({
  validator: (parse: (raw: unknown) => unknown) => ({
    handler:
      (run: Handler) =>
      ({ data }: { data: unknown }) =>
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
let objects: Awaited<ReturnType<typeof createCalendarTest>>;
const cookies = new Map<UserId, string>();
const people = {} as Record<CalendarRole | "outsider", UserId>;

beforeEach(async () => {
  kit = await createKit();
  objects = await createCalendarTest();
  env.DB = kit.database;
  env.CALENDAR = objects.env.CALENDAR;
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
    const response = await signIn(kit, email);
    cookies.set(id, response.headers.get("set-cookie")!);
  }
  kit.sqlite.run(
    "INSERT INTO calendars (id, kind, name, colour) VALUES (?, 'team', 'Marketing', 2)",
    [TEAM],
  );
  for (const role of ["manager", "editor", "viewer"] as const) {
    kit.sqlite.run(
      "INSERT INTO calendar_access (calendar_id, user_id, role) VALUES (?, ?, ?)",
      [TEAM, people[role], role],
    );
  }
  objects.arrive({
    uid: "launch-review",
    title: "Spring launch review",
    start: Date.parse("2026-11-05T11:00:00+11:00"),
    end: Date.parse("2026-11-05T12:00:00+11:00"),
    timeZone: SYDNEY,
    rule: null,
    organiser: { kind: "madeHere", userId: people.manager },
  });
});

function as(userId: UserId) {
  request = new Request("https://calendar.example.com/_serverFn/x", {
    method: "POST",
    headers: { cookie: cookies.get(userId)! },
  });
  return functions;
}

const calendarNow = () => ({
  calendar: kit.rows("SELECT name, colour FROM calendars"),
  members: kit.rows(
    "SELECT user_id, role FROM calendar_access ORDER BY user_id",
  ),
  events: objects.sqlite().query("SELECT uid FROM events").all(),
});

const managerOnly = {
  rename: (as: typeof functions) =>
    as.renameTeamCalendar({ data: { calendarId: TEAM, name: "Taken over" } }),
  recolour: (as: typeof functions) =>
    as.setCalendarColour({ data: { calendarId: TEAM, colour: 5 } }),
  delete: (as: typeof functions) =>
    as.deleteTeamCalendar({ data: { calendarId: TEAM } }),
  "add a member": (as: typeof functions) =>
    as.addMembers({
      data: { calendarId: TEAM, people: [people.outsider], role: "manager" },
    }),
  "change a member's role": (as: typeof functions) =>
    as.changeMemberRole({
      data: { calendarId: TEAM, userId: people.viewer, role: "manager" },
    }),
  "remove a member": (as: typeof functions) =>
    as.removeCalendarMember({
      data: { calendarId: TEAM, userId: people.manager },
    }),
};

test.each(
  (
    [
      ["Can edit", "editor"],
      ["Can view", "viewer"],
    ] as const
  ).flatMap(([label, role]) =>
    (Object.keys(managerOnly) as (keyof typeof managerOnly)[]).map(
      (action) => [label, action, role] as const,
    ),
  ),
)("%s is refused when they try to %s", async (_, action, role) => {
  const before = calendarNow();
  const refused = await managerOnly[action](as(people[role])).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(refused).toBeInstanceOf(Response);
  expect((refused as Response).status).toBe(403);
  expect(
    ((await (refused as Response).json()) as { message: string }).message,
  ).toBe(ONLY_MANAGERS_MESSAGE);
  expect(calendarNow()).toEqual(before);
});

test("a manager renames a team calendar, then deletes it and its events", async () => {
  await as(people.manager).renameTeamCalendar({
    data: { calendarId: TEAM, name: "Launch" },
  });
  expect(calendarNow().calendar).toEqual([{ name: "Launch", colour: 2 }]);

  await as(people.manager).deleteTeamCalendar({ data: { calendarId: TEAM } });
  expect(calendarNow()).toEqual({ calendar: [], members: [], events: [] });
});
