import { beforeEach, expect, mock, test } from "bun:test";
import type { CalendarRole, UserId } from "@cloudysuite/access";
import * as start from "@tanstack/react-start";
import * as startServer from "@tanstack/react-start/server";
import { testWorkerEnv } from "../../../src/db/test-database";
import { handOver } from "../../auth/src/admin/handover";
import {
  createKit,
  type Kit,
  PASSWORD,
  signIn,
} from "../../auth/src/admin/test-kit";
import { createCalendarTest, date, draft, SYDNEY, TEAM } from "./test-support";
import {
  type ChangeScope,
  type EventTime,
  LAST_MANAGER_MESSAGE,
  NO_ACCESS_MESSAGE,
  NOT_A_PERSON_MESSAGE,
  type OccurrenceId,
  ONLY_MANAGERS_MESSAGE,
  PERSONAL_CALENDAR_MESSAGE,
  READ_ONLY_MESSAGE,
  VIEW_ONLY_MESSAGE,
} from "./types";
import { controlsFor, draftOf, formOf } from "./ui/event-form";

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
    organiser: { kind: "madeHere", userId: people.manager, name: "Boss" },
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

async function refused(attempt: Promise<unknown>) {
  const thrown = await attempt.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(thrown instanceof Response)) throw new Error("expected a refusal");
  return {
    status: thrown.status,
    message: ((await thrown.json()) as { message: string }).message,
  };
}

const teamFor = async (userId: UserId) =>
  (await as(userId).getCalendars()).find((entry) => entry.id === TEAM);

const timed = (start: string, end: string): EventTime =>
  ({
    kind: "timed",
    start: Date.parse(start),
    end: Date.parse(end),
    timeZone: SYDNEY,
  }) as EventTime;

test("the last manager can't leave or step down, and anyone else can leave", async () => {
  expect(
    await refused(
      as(people.manager).leaveTeamCalendar({ data: { calendarId: TEAM } }),
    ),
  ).toEqual({ status: 409, message: LAST_MANAGER_MESSAGE });
  expect(
    await refused(
      as(people.manager).changeMemberRole({
        data: { calendarId: TEAM, userId: people.manager, role: "editor" },
      }),
    ),
  ).toEqual({ status: 409, message: LAST_MANAGER_MESSAGE });

  await as(people.viewer).leaveTeamCalendar({ data: { calendarId: TEAM } });
  expect(await teamFor(people.viewer)).toBeUndefined();
  expect(
    await refused(as(people.viewer).getMembers({ data: { calendarId: TEAM } })),
  ).toEqual({ status: 403, message: NO_ACCESS_MESSAGE });

  await as(people.manager).changeMemberRole({
    data: { calendarId: TEAM, userId: people.editor, role: "manager" },
  });
  await as(people.manager).leaveTeamCalendar({ data: { calendarId: TEAM } });
  expect(calendarNow().members).toEqual([
    { user_id: people.editor, role: "manager" },
  ]);
});

test("removing someone takes their access away on their next request", async () => {
  const meeting = draft(
    timed("2026-11-06T09:00:00+11:00", "2026-11-06T10:00:00+11:00"),
  );
  await as(people.editor).createEvent({
    data: { calendarId: TEAM, draft: meeting },
  });
  await as(people.manager).removeCalendarMember({
    data: { calendarId: TEAM, userId: people.editor },
  });
  expect(await teamFor(people.editor)).toBeUndefined();
  expect(
    await refused(
      as(people.editor).createEvent({
        data: { calendarId: TEAM, draft: meeting },
      }),
    ),
  ).toEqual({ status: 403, message: NO_ACCESS_MESSAGE });
});

test("the delete confirmation counts each event once, however often it repeats", async () => {
  const uid = await as(people.editor).createEvent({
    data: {
      calendarId: TEAM,
      draft: draft(
        timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
        { repeat: { frequency: "weekly", end: { kind: "never" } } },
      ),
    },
  });
  await as(people.editor).updateEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: "20261108T220000Z" as OccurrenceId },
      scope: "this",
      draft: draft(
        timed("2026-11-09T10:00:00+11:00", "2026-11-09T10:15:00+11:00"),
      ),
    },
  });
  const count = (userId: UserId) =>
    as(userId).countCalendarEvents({ data: { calendarId: TEAM } });
  expect(await count(people.viewer)).toBe(2);
  expect(await count(people.manager)).toBe(2);

  await as(people.manager).deleteTeamCalendar({ data: { calendarId: TEAM } });
  expect(calendarNow().events).toEqual([]);
  expect(await refused(count(people.manager))).toEqual({
    status: 403,
    message: NO_ACCESS_MESSAGE,
  });
});

test("a personal calendar takes a new colour, but can't be deleted, left, renamed, or shared", async () => {
  const mine = await as(people.viewer).ensureMyCalendar();
  const attempts = [
    () => as(people.viewer).deleteTeamCalendar({ data: { calendarId: mine } }),
    () => as(people.viewer).leaveTeamCalendar({ data: { calendarId: mine } }),
    () =>
      as(people.viewer).renameTeamCalendar({
        data: { calendarId: mine, name: "Shared now" },
      }),
    () =>
      as(people.viewer).addMembers({
        data: { calendarId: mine, people: [people.editor], role: "viewer" },
      }),
    () =>
      as(people.viewer).changeMemberRole({
        data: { calendarId: mine, userId: people.viewer, role: "viewer" },
      }),
    () =>
      as(people.viewer).removeCalendarMember({
        data: { calendarId: mine, userId: people.viewer },
      }),
  ];
  for (const attempt of attempts) {
    expect(await refused(attempt())).toEqual({
      status: 403,
      message: PERSONAL_CALENDAR_MESSAGE,
    });
  }
  expect(
    await refused(
      as(people.editor).setCalendarColour({
        data: { calendarId: mine, colour: 1 },
      }),
    ),
  ).toEqual({ status: 403, message: NO_ACCESS_MESSAGE });

  await as(people.viewer).setCalendarColour({
    data: { calendarId: mine, colour: 1 },
  });
  expect((await as(people.viewer).getCalendars())[0]).toMatchObject({
    id: mine,
    kind: "personal",
    colour: 1,
  });
  expect(
    await as(people.viewer).getMembers({ data: { calendarId: mine } }),
  ).toMatchObject([{ person: { id: people.viewer }, role: "manager" }]);
});

test("someone suspended or removed can't be added, and nobody is added with them", async () => {
  const { user } = await kit.auth.api.createUser({
    body: { email: "newcomer@example.com", password: PASSWORD, name: "New" },
  });
  const newcomer = user.id as UserId;
  kit.sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [people.outsider]);
  const before = calendarNow().members;
  for (const others of [[people.outsider], ["user-gone" as UserId]]) {
    expect(
      await refused(
        as(people.manager).addMembers({
          data: {
            calendarId: TEAM,
            people: [newcomer, ...others],
            role: "editor",
          },
        }),
      ),
    ).toEqual({ status: 404, message: NOT_A_PERSON_MESSAGE });
  }
  expect(calendarNow().members).toEqual(before);

  await as(people.manager).addMembers({
    data: { calendarId: TEAM, people: [newcomer], role: "editor" },
  });
  expect(calendarNow().members).toContainEqual({
    user_id: newcomer,
    role: "editor",
  });
  expect(
    (await as(people.manager).getPeopleChoices()).map((person) => person.id),
  ).not.toContain(people.outsider);
});

test("someone not on a team calendar can't even see who's on it", async () => {
  kit.sqlite.run("DELETE FROM calendar_access WHERE user_id = ?", [
    people.viewer,
  ]);
  for (const attempt of [
    () => as(people.viewer).getMembers({ data: { calendarId: TEAM } }),
    () => as(people.viewer).countCalendarEvents({ data: { calendarId: TEAM } }),
    () => as(people.viewer).leaveTeamCalendar({ data: { calendarId: TEAM } }),
    () =>
      as(people.viewer).renameTeamCalendar({
        data: { calendarId: TEAM, name: "Mine now" },
      }),
  ]) {
    expect(await refused(attempt())).toEqual({
      status: 403,
      message: NO_ACCESS_MESSAGE,
    });
  }
});

test("everyone on a team calendar sees its new colour", async () => {
  await as(people.manager).setCalendarColour({
    data: { calendarId: TEAM, colour: 5 },
  });
  expect(await teamFor(people.viewer)).toMatchObject({ colour: 5 });
});

test("removing someone hands their calendar to the person chosen, events and all", async () => {
  const removed = people.editor;
  kit.sqlite.run("UPDATE user SET name = 'Sam Rivera' WHERE id = ?", [removed]);
  const theirs = await as(removed).ensureMyCalendar();
  await as(removed).createEvent({
    data: {
      calendarId: theirs,
      draft: draft(
        timed("2026-11-10T15:00:00+11:00", "2026-11-10T16:00:00+11:00"),
        { title: "Supplier call" },
      ),
    },
  });
  const planning = await as(removed).createEvent({
    data: {
      calendarId: TEAM,
      draft: draft(
        timed("2026-11-11T09:00:00+11:00", "2026-11-11T10:00:00+11:00"),
        { title: "Planning" },
      ),
    },
  });

  await handOver(kit.database, removed, "Sam Rivera", people.viewer);
  await kit.auth.api.removeUser({
    headers: new Headers({ cookie: cookies.get(people.manager)! }),
    body: { userId: removed },
  });

  const recipient = as(people.viewer);
  const handed = (await recipient.getCalendars()).find(
    (entry) => entry.id === theirs,
  );
  expect(handed).toMatchObject({
    kind: "team",
    name: "Sam Rivera's calendar",
    role: "manager",
  });
  expect(handed?.colour).not.toBe(4);
  expect(
    await recipient.getMembers({ data: { calendarId: theirs } }),
  ).toMatchObject([{ person: { id: people.viewer }, role: "manager" }]);
  const november = { from: date("2026-11-01"), to: date("2026-12-01") };
  const { occurrences } = await recipient.listEvents({
    data: { ...november, timeZone: SYDNEY },
  });
  expect(occurrences).toContainEqual(
    expect.objectContaining({ calendarId: theirs, title: "Supplier call" }),
  );
  expect(
    kit.rows(`SELECT 1 FROM calendar_access WHERE user_id = '${removed}'`),
  ).toEqual([]);

  // Their event on the team calendar stays with their name, though their user row is
  // gone, and Can edit there can still change it.
  expect(kit.rows(`SELECT 1 FROM user WHERE id = '${removed}'`)).toEqual([]);
  await as(people.manager).updateEvent({
    data: {
      calendarId: TEAM,
      target: { uid: planning, occurrenceId: null },
      scope: "all",
      draft: draft(
        timed("2026-11-11T10:00:00+11:00", "2026-11-11T11:00:00+11:00"),
        { title: "Planning, moved" },
      ),
    },
  });
  const team = await as(people.manager).listEvents({
    data: { ...november, timeZone: SYDNEY },
  });
  expect(team.occurrences).toContainEqual(
    expect.objectContaining({
      calendarId: TEAM,
      title: "Planning, moved",
      organiser: { kind: "madeHere", userId: removed, name: "Sam Rivera" },
    }),
  );
});

const SERIES_DAYS = [
  "2026-11-02",
  "2026-11-09",
  "2026-11-16",
  "2026-11-23",
  "2026-11-30",
  "2026-12-07",
  "2026-12-14",
  "2026-12-21",
  "2026-12-28",
  "2027-01-04",
];

async function seriesNow() {
  const { occurrences } = await as(people.editor).listEvents({
    data: {
      from: date("2026-11-01"),
      to: date("2027-03-01"),
      timeZone: SYDNEY,
    },
  });
  return occurrences
    .filter((occurrence) => occurrence.title !== "Spring launch review")
    .map((occurrence) => [
      occurrence.title,
      new Date((occurrence.time as { start: number }).start).toLocaleDateString(
        "en-CA",
        { timeZone: SYDNEY },
      ),
    ]);
}

const titled = (titleOn: (index: number) => string | null) =>
  SERIES_DAYS.flatMap((day, index) => {
    const title = titleOn(index);
    return title ? [[title, day]] : [];
  });

test.each([
  ["save", "this", titled((i) => (i === 3 ? "Changed" : "Standup"))],
  ["save", "thisAndLater", titled((i) => (i >= 3 ? "Changed" : "Standup"))],
  ["save", "all", titled(() => "Changed")],
  ["delete", "this", titled((i) => (i === 3 ? null : "Standup"))],
  ["delete", "thisAndLater", titled((i) => (i >= 3 ? null : "Standup"))],
  ["delete", "all", titled(() => null)],
] as const)(
  "%s with %s on the fourth of ten dates covers what it says",
  async (action, scope: ChangeScope, expected) => {
    await as(people.editor).createEvent({
      data: {
        calendarId: TEAM,
        draft: draft(
          timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
          {
            title: "Standup",
            repeat: {
              frequency: "weekly",
              end: { kind: "afterTimes", times: 10 },
            },
          },
        ),
      },
    });
    const { occurrences } = await as(people.editor).listEvents({
      data: {
        from: date("2026-11-23"),
        to: date("2026-11-24"),
        timeZone: SYDNEY,
      },
    });
    const fourth = occurrences[0]!;
    const target = { uid: fourth.uid, occurrenceId: fourth.occurrenceId };

    if (action === "save") {
      const checked = draftOf(
        { ...formOf(fourth, SYDNEY), title: "Changed" },
        SYDNEY,
      );
      if (!checked.ok) throw new Error(checked.message);
      await as(people.editor).updateEvent({
        data: { calendarId: TEAM, target, scope, draft: checked.draft },
      });
    } else {
      await as(people.editor).deleteEvent({
        data: { calendarId: TEAM, target, scope },
      });
    }
    expect(await seriesNow()).toEqual(expected);
  },
);

test("Can view is refused making, changing, or deleting an event, and sees no buttons for it", async () => {
  const target = { uid: "launch-review", occurrenceId: null };
  const meeting = draft(
    timed("2026-11-06T09:00:00+11:00", "2026-11-06T10:00:00+11:00"),
  );
  const viewer = as(people.viewer);
  const before = calendarNow().events;
  for (const attempt of [
    () => viewer.createEvent({ data: { calendarId: TEAM, draft: meeting } }),
    () =>
      viewer.updateEvent({
        data: { calendarId: TEAM, target, scope: "all", draft: meeting },
      }),
    () =>
      viewer.deleteEvent({ data: { calendarId: TEAM, target, scope: "all" } }),
  ]) {
    expect(await refused(attempt())).toEqual({
      status: 403,
      message: VIEW_ONLY_MESSAGE,
    });
  }
  expect(calendarNow().events).toEqual(before);
  const [seen] = (
    await viewer.listEvents({
      data: {
        from: date("2026-11-05"),
        to: date("2026-11-06"),
        timeZone: SYDNEY,
      },
    })
  ).occurrences;
  expect(controlsFor(seen!, (await teamFor(people.viewer))!)).toBe("none");
});

test("an invitation copy has no Edit, is refused a change, and can be removed", async () => {
  objects.arrive({
    uid: "supplier@example.net",
    title: "Supplier call",
    start: Date.parse("2026-11-10T15:00:00+11:00"),
    end: Date.parse("2026-11-10T15:30:00+11:00"),
    timeZone: SYDNEY,
    rule: null,
    organiser: { kind: "invitation", email: "jo@example.net", name: "Jo" },
  });
  const editor = as(people.editor);
  const day = {
    from: date("2026-11-10"),
    to: date("2026-11-11"),
    timeZone: SYDNEY,
  };
  const [copy] = (await editor.listEvents({ data: day })).occurrences;
  expect(controlsFor(copy!, (await teamFor(people.editor))!)).toBe(
    "removeOnly",
  );

  const target = { uid: copy!.uid, occurrenceId: null };
  const checked = draftOf(
    { ...formOf(copy!, SYDNEY), title: "Mine now" },
    SYDNEY,
  );
  if (!checked.ok) throw new Error(checked.message);
  expect(
    await refused(
      editor.updateEvent({
        data: { calendarId: TEAM, target, scope: "all", draft: checked.draft },
      }),
    ),
  ).toEqual({ status: 403, message: READ_ONLY_MESSAGE });
  expect((await editor.listEvents({ data: day })).occurrences).toMatchObject([
    { title: "Supplier call" },
  ]);

  await editor.deleteEvent({
    data: { calendarId: TEAM, target, scope: "all" },
  });
  expect((await editor.listEvents({ data: day })).occurrences).toEqual([]);
});
