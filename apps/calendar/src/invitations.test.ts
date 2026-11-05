import { beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import type { CalendarId, CalendarRole, UserId } from "@cloudysuite/access";
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
import { calendarFile } from "./outside/test-support";
import { createCalendarTest, SYDNEY, TEAM } from "./test-support";
import {
  type Answer,
  type CalendarOccurrence,
  type ChangeScope,
  type CivilDate,
  EVENT_GONE_MESSAGE,
  type EventDraft,
  type EventTime,
  type EventUid,
  NO_ACCESS_MESSAGE,
  type OccurrenceId,
  PEOPLE_FOR_ONE_DATE_MESSAGE,
  VIEW_ONLY_MESSAGE,
} from "./types";
import { scopesFor } from "./ui/event-form";

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
const functions = {
  ...(await import("./functions")),
  ...(await import("./search-functions")),
};

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
  // The objects' alarms read the same directory as the server functions.
  (objects.env as unknown as Record<string, unknown>).DB = kit.database;
  people.manager = kit.admin;
  const emails = new Map([[kit.admin, "boss@example.com"]]);
  for (const [role, name, email] of [
    ["editor", "Maya Chen", "maya@example.com"],
    ["viewer", "Ravi Patel", "ravi@example.com"],
    ["outsider", "Jo Okafor", "jo@example.com"],
  ] as const) {
    const { user } = await kit.auth.api.createUser({
      body: { email, password: PASSWORD, name },
    });
    people[role] = user.id as UserId;
    emails.set(people[role], email);
  }
  // Sign-in allows a few tries a minute from one address, and every test signs in four.
  for (const [id, email] of emails) {
    kit.sqlite.run("DELETE FROM rate_limit");
    cookies.set(id, signInCookie(await signIn(kit, email)));
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
});

function signInCookie(response: Response) {
  return response.headers.get("set-cookie")!;
}

function as(userId: UserId) {
  request = new Request("https://calendar.example.com/_serverFn/x", {
    method: "POST",
    headers: { cookie: cookies.get(userId)! },
  });
  return functions;
}

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

const timed = (start: string, end: string): EventTime =>
  ({
    kind: "timed",
    start: Date.parse(start),
    end: Date.parse(end),
    timeZone: SYDNEY,
  }) as EventTime;

const TUESDAY = timed("2026-11-10T09:00:00+11:00", "2026-11-10T10:00:00+11:00");
const LATER = timed("2026-11-10T11:00:00+11:00", "2026-11-10T12:00:00+11:00");
const WEEKLY = { frequency: "weekly", end: { kind: "never" } } as const;
const DAILY = { frequency: "daily", end: { kind: "never" } } as const;
// The second and third Tuesdays, as RECURRENCE-IDs.
const SECOND = "20261116T220000Z" as OccurrenceId;
const THIRD = "20261123T220000Z" as OccurrenceId;

const planning = (more: Partial<EventDraft> = {}): EventDraft => ({
  title: "Weekly planning",
  location: "",
  notes: "",
  time: TUESDAY,
  repeat: null,
  people: [],
  ...more,
});

async function invite(
  invited: UserId[],
  more: Partial<EventDraft> = {},
): Promise<EventUid> {
  const uid = await as(people.manager).createEvent({
    data: { calendarId: TEAM, draft: planning({ people: invited, ...more }) },
  });
  await objects.settle();
  return uid;
}

type Target = { occurrenceId: OccurrenceId | null; scope: ChangeScope };
const ALL: Target = { occurrenceId: null, scope: "all" };

// A change whose deliveries haven't gone yet, so the next one joins them.
const unsent = (uid: EventUid, more: Partial<EventDraft>, target = ALL) =>
  as(people.manager).updateEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: target.occurrenceId },
      scope: target.scope,
      draft: planning(more),
    },
  });

async function change(uid: EventUid, more: Partial<EventDraft>, target = ALL) {
  await unsent(uid, more, target);
  await objects.settle();
}

const personalOf = async (userId: UserId) =>
  (await as(userId).getCalendars())[0]?.id as CalendarId;

// What this person sees in Schedule over four weeks from the first Tuesday.
async function seen(userId: UserId): Promise<CalendarOccurrence[]> {
  const { occurrences } = await as(userId).listEvents({
    data: {
      from: "2026-11-09" as CivilDate,
      to: "2026-12-07" as CivilDate,
      timeZone: SYDNEY,
    },
  });
  return occurrences;
}

// The person's own copy of the organiser's event, as their calendar lists it.
async function copyIn(userId: UserId, uid: EventUid): Promise<EventUid> {
  const listed = [
    ...(await seen(userId)),
    ...(await as(userId).listInvitations({ data: { timeZone: SYDNEY } })),
  ];
  const copy = listed.find((entry) => entry.uid === uid);
  if (!copy) throw new Error("expected a copy");
  return copy.uid;
}

async function answer(userId: UserId, uid: EventUid, given: Answer) {
  await as(userId).answerInvitation({
    data: {
      calendarId: await personalOf(userId),
      uid: await copyIn(userId, uid),
      answer: given,
    },
  });
  await objects.settle();
}

const answers = (occurrence: CalendarOccurrence | undefined) =>
  Object.fromEntries(
    (occurrence?.people ?? []).map((person) => [person.name, person.answer]),
  );

test("inviting two colleagues puts one unanswered copy in each one's own calendar", async () => {
  const uid = await invite([people.editor, people.outsider]);

  for (const userId of [people.editor, people.outsider]) {
    const entries = await seen(userId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      uid,
      calendarId: await personalOf(userId),
      title: "Weekly planning",
      answer: "needsAnswer",
      changeable: false,
      cancelled: false,
      organiser: { kind: "colleague", name: "Boss", calendarId: TEAM },
    });
    expect(answers(entries[0])).toEqual({
      "Maya Chen": "needsAnswer",
      "Jo Okafor": "needsAnswer",
    });
  }
  // The organiser sees who they invited, and no answer buttons of their own.
  const [organisers] = await seen(people.manager);
  expect(organisers).toMatchObject({ calendarId: TEAM, answer: null });
  expect(organisers?.people.map((person) => person.name)).toEqual([
    "Maya Chen",
    "Jo Okafor",
  ]);
});

test("the same delivery twice, or an older one late, leaves one copy at its newest", async () => {
  const uid = await invite([people.outsider]);
  const [first] = objects.delivered;
  if (!first) throw new Error("expected a delivery");
  await change(uid, { title: "Planning, moved", people: [people.outsider] });
  const latest = objects.delivered.at(-1)!;

  expect(objects.deliverAgain(latest.to, latest.delivery)).toBe("unchanged");
  expect(objects.deliverAgain(first.to, first.delivery)).toBe("unchanged");
  const entries = await seen(people.outsider);
  expect(entries.map((entry) => entry.title)).toEqual(["Planning, moved"]);
});

test("a removed copy stays removed when the organiser changes the event", async () => {
  const uid = await invite([people.outsider]);
  await as(people.outsider).deleteEvent({
    data: {
      calendarId: await personalOf(people.outsider),
      target: { uid: await copyIn(people.outsider, uid), occurrenceId: null },
      scope: "all",
    },
  });
  await change(uid, { title: "Planning, moved", people: [people.outsider] });
  expect(await seen(people.outsider)).toEqual([]);
});

test("a cancelled date, then a cancelled event, show as called off in every copy", async () => {
  const uid = await invite([people.editor, people.outsider], {
    repeat: WEEKLY,
  });
  await as(people.manager).deleteEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: SECOND },
      scope: "this",
    },
  });
  await objects.settle();
  for (const userId of [people.editor, people.outsider]) {
    const entries = await seen(userId);
    expect(
      entries.map((entry): [string | null, boolean] => [
        entry.occurrenceId,
        entry.cancelled,
      ]),
    ).toEqual([
      ["20261109T220000Z", false],
      [SECOND, true],
      [THIRD, false],
      ["20261130T220000Z", false],
    ]);
  }
  // The organiser removed it, so it's gone from the team calendar.
  expect(
    (await seen(people.manager)).map((entry) => entry.occurrenceId),
  ).not.toContain(SECOND);

  await as(people.manager).deleteEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: null },
      scope: "all",
    },
  });
  await objects.settle();
  for (const userId of [people.editor, people.outsider]) {
    const entries = await seen(userId);
    expect(entries).toHaveLength(4);
    expect(entries.every((entry) => entry.cancelled)).toBe(true);
  }
});

test("an answer reaches the organiser, and everyone else invited sees it", async () => {
  const uid = await invite([people.editor, people.outsider]);
  await answer(people.outsider, uid, "yes");
  await answer(people.editor, uid, "no");

  expect(answers((await seen(people.manager))[0])).toEqual({
    "Maya Chen": "no",
    "Jo Okafor": "yes",
  });
  const [jos] = await seen(people.outsider);
  expect(jos?.answer).toBe("yes");
  expect(answers(jos)).toEqual({ "Maya Chen": "no", "Jo Okafor": "yes" });

  // Changing an answer counts, and an older one arriving late doesn't undo it.
  await answer(people.outsider, uid, "maybe");
  expect(answers((await seen(people.manager))[0])["Jo Okafor"]).toBe("maybe");
});

test("someone on the team calendar who is also invited sees the event once, as their copy", async () => {
  const uid = await invite([people.viewer], { repeat: WEEKLY });
  const entries = await seen(people.viewer);
  expect(entries).toHaveLength(4);
  expect(
    entries.every(
      (entry) =>
        entry.uid === uid &&
        entry.organiser.kind === "colleague" &&
        entry.answer === "needsAnswer",
    ),
  ).toBe(true);
  const { occurrences } = (await as(people.viewer).searchEvents({
    data: { text: "planning", timeZone: SYDNEY },
  })) as { occurrences: CalendarOccurrence[] };
  expect(occurrences.map((entry) => entry.organiser.kind)).toEqual([
    "colleague",
  ]);
});

test("nobody can put an event in someone else's calendar through a server function", async () => {
  const theirs = await as(people.manager).ensureMyCalendar();
  const uid = await as(people.manager).createEvent({
    data: { calendarId: theirs, draft: planning({ title: "Private" }) },
  });
  const target = { uid, occurrenceId: null };
  const attempts = {
    create: () =>
      as(people.outsider).createEvent({
        data: { calendarId: theirs, draft: planning() },
      }),
    update: () =>
      as(people.outsider).updateEvent({
        data: { calendarId: theirs, target, scope: "all", draft: planning() },
      }),
    delete: () =>
      as(people.outsider).deleteEvent({
        data: { calendarId: theirs, target, scope: "all" },
      }),
    answer: () =>
      as(people.outsider).answerInvitation({
        data: { calendarId: theirs, uid, answer: "yes" },
      }),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    expect([name, await refused(attempt())]).toEqual([
      name,
      { status: 403, message: NO_ACCESS_MESSAGE },
    ]);
  }
  expect((await seen(people.manager)).map((entry) => entry.title)).toEqual([
    "Private",
  ]);

  // Inviting someone is the one way in, and it arrives as a copy that names who sent it,
  // which they can't change, only answer or remove.
  await as(people.outsider).createEvent({
    data: {
      calendarId: await as(people.outsider).ensureMyCalendar(),
      draft: planning({ title: "From Jo", people: [people.manager] }),
    },
  });
  await objects.settle();
  const copy = (await seen(people.manager)).find(
    (entry) => entry.title === "From Jo",
  );
  expect(copy).toMatchObject({
    calendarId: theirs,
    changeable: false,
    organiser: {
      kind: "colleague",
      userId: people.outsider,
      name: "Jo Okafor",
    },
  });
});

test("Can view can't invite anyone", async () => {
  expect(
    await refused(
      as(people.viewer).createEvent({
        data: {
          calendarId: TEAM,
          draft: planning({ people: [people.outsider] }),
        },
      }),
    ),
  ).toEqual({ status: 403, message: VIEW_ONLY_MESSAGE });
  await objects.settle();
  expect(await seen(people.outsider)).toEqual([]);
});

test("removing a repeating copy covers only this one, this and later ones, or all of them", async () => {
  const uid = await invite([people.outsider], { repeat: WEEKLY });
  const mine = await personalOf(people.outsider);
  const copy = await copyIn(people.outsider, uid);
  const [first] = await seen(people.outsider);
  expect(scopesFor(first!, null)).toEqual(["this", "thisAndLater", "all"]);

  const remove = (occurrenceId: OccurrenceId, scope: ChangeScope) =>
    as(people.outsider).deleteEvent({
      data: { calendarId: mine, target: { uid: copy, occurrenceId }, scope },
    });
  const dates = async () =>
    (await seen(people.outsider)).map((entry) => [
      entry.title,
      entry.occurrenceId,
    ]);

  await remove(SECOND, "this");
  await change(uid, {
    title: "Renamed",
    repeat: WEEKLY,
    people: [people.outsider],
  });
  expect(await dates()).toEqual([
    ["Renamed", "20261109T220000Z"],
    ["Renamed", THIRD],
    ["Renamed", "20261130T220000Z"],
  ]);

  await remove(THIRD, "thisAndLater");
  await change(uid, {
    title: "Renamed again",
    repeat: WEEKLY,
    people: [people.outsider],
  });
  expect(await dates()).toEqual([["Renamed again", "20261109T220000Z"]]);

  // From the first date, this and later ones is all of them, and none come back.
  await remove("20261109T220000Z" as OccurrenceId, "thisAndLater");
  await change(uid, {
    title: "Back?",
    repeat: WEEKLY,
    people: [people.outsider],
  });
  expect(await dates()).toEqual([]);
});

test("only this one can't change who's invited", async () => {
  const uid = await invite([people.outsider], { repeat: WEEKLY });
  expect(
    await refused(
      as(people.manager).updateEvent({
        data: {
          calendarId: TEAM,
          target: { uid, occurrenceId: SECOND },
          scope: "this",
          draft: planning({ people: [people.outsider, people.editor] }),
        },
      }),
    ),
  ).toEqual({ status: 400, message: PEOPLE_FOR_ONE_DATE_MESSAGE });
});

test("someone taken off the people list finds their copy called off", async () => {
  const uid = await invite([people.editor, people.outsider]);
  await change(uid, { people: [people.editor] });
  expect((await seen(people.outsider))[0]?.cancelled).toBe(true);
  expect(answers((await seen(people.editor))[0])).toEqual({
    "Maya Chen": "needsAnswer",
  });
});

test("someone removed from the organisation is skipped, and everyone else still hears", async () => {
  const uid = await invite([people.editor, people.outsider]);
  await handOver(kit.database, people.outsider, "Jo Okafor", people.viewer);
  await kit.auth.api.removeUser({
    headers: new Headers({ cookie: cookies.get(people.manager)! }),
    body: { userId: people.outsider },
  });

  await change(uid, {
    title: "Planning, moved",
    people: [people.editor, people.outsider],
  });
  expect(objects.alarmOf(TEAM)).toBeNull();
  expect((await seen(people.editor))[0]?.title).toBe("Planning, moved");
  expect(objects.delivered.at(-1)?.to).toBe(await personalOf(people.editor));
});

test("a delivery that fails is tried again later, and then arrives", async () => {
  const theirs = await as(people.outsider).ensureMyCalendar();
  objects.unreachable.add(theirs);
  await invite([people.outsider]);
  expect(await seen(people.outsider)).toEqual([]);
  const retry = objects.alarmOf(TEAM);
  expect(retry).toBeGreaterThan(Date.now());

  objects.unreachable.delete(theirs);
  setSystemTime(new Date(retry!));
  try {
    await objects.settle();
  } finally {
    setSystemTime();
  }
  expect((await seen(people.outsider)).map((entry) => entry.title)).toEqual([
    "Weekly planning",
  ]);
  expect(objects.alarmOf(TEAM)).toBeNull();
});

test("deleting the team calendar calls off every copy of its events", async () => {
  await invite([people.outsider], { repeat: WEEKLY });
  await as(people.manager).deleteTeamCalendar({ data: { calendarId: TEAM } });
  await objects.settle();
  const entries = await seen(people.outsider);
  expect(entries).toHaveLength(4);
  expect(entries.every((entry) => entry.cancelled)).toBe(true);
});

test("an answer to an event that's gone is refused in plain words", async () => {
  expect(
    await refused(
      as(people.outsider).answerInvitation({
        data: {
          calendarId: await as(people.outsider).ensureMyCalendar(),
          uid: "not-an-event" as EventUid,
          answer: "yes",
        },
      }),
    ),
  ).toEqual({ status: 404, message: EVENT_GONE_MESSAGE });
});

test("an organiser's name is kept to 100 characters", async () => {
  kit.sqlite.run("UPDATE user SET name = ? WHERE id = ?", [
    "A".repeat(150),
    people.manager,
  ]);
  await invite([people.outsider]);
  const [copy] = await seen(people.outsider);
  expect(copy?.organiser).toMatchObject({ name: "A".repeat(100) });
});

test("Today lists unanswered invitations, even from a hidden calendar", async () => {
  const uid = await invite([people.outsider], { repeat: WEEKLY });
  await invite([people.outsider], { title: "Board review" });
  const mine = await personalOf(people.outsider);
  await as(people.outsider).setCalendarHidden({
    data: { calendarId: mine, hidden: true },
  });
  expect(await seen(people.outsider)).toEqual([]);

  setSystemTime(new Date("2026-11-12T00:00:00+11:00"));
  try {
    const waiting = await as(people.outsider).listInvitations({
      data: { timeZone: SYDNEY },
    });
    expect(waiting.map((entry) => [entry.title, entry.occurrenceId])).toEqual([
      ["Weekly planning", SECOND],
    ]);
    await answer(people.outsider, uid, "yes");
    expect(
      await as(people.outsider).listInvitations({ data: { timeZone: SYDNEY } }),
    ).toEqual([]);
  } finally {
    setSystemTime();
  }
});

// The second date changed three times, so a copy holds it at a higher sequence than the
// series.
async function changeSecondDate(uid: EventUid) {
  for (const title of ["Moved", "Moved again", "Moved once more"]) {
    await change(
      uid,
      {
        title,
        time: timed("2026-11-17T14:00:00+11:00", "2026-11-17T15:00:00+11:00"),
        repeat: WEEKLY,
        people: [people.outsider],
      },
      { occurrenceId: SECOND, scope: "this" },
    );
  }
}

test("deleting an event reaches a copy that missed the change before it", async () => {
  const uid = await invite([people.outsider], { repeat: WEEKLY });
  await changeSecondDate(uid);
  // Every date moves, which drops the changed one, then the event goes, all before the
  // alarm runs. Jo's copy only hears the deletion.
  await unsent(uid, { time: LATER, repeat: WEEKLY, people: [people.outsider] });
  await as(people.manager).deleteEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: null },
      scope: "all",
    },
  });
  await objects.settle();
  const entries = await seen(people.outsider);
  expect(entries).toHaveLength(4);
  expect(entries.every((entry) => entry.cancelled)).toBe(true);
});

test("a date changed again after every date moved reaches a copy that missed the move", async () => {
  const uid = await invite([people.outsider], { repeat: WEEKLY });
  await changeSecondDate(uid);
  await unsent(uid, { repeat: DAILY, people: [people.outsider] });
  await unsent(
    uid,
    {
      title: "Fresh",
      time: timed("2026-11-17T16:00:00+11:00", "2026-11-17T17:00:00+11:00"),
      repeat: DAILY,
      people: [people.outsider],
    },
    { occurrenceId: SECOND, scope: "this" },
  );
  await objects.settle();
  const second = (await seen(people.outsider)).find(
    (entry) => entry.occurrenceId === SECOND,
  );
  expect(second).toMatchObject({ title: "Fresh", cancelled: false });
});

const FROM_A_FILE = "planning-from-a-file" as EventUid;

// One event with FROM_A_FILE's UID, imported into the team calendar.
const importToTeam = (...lines: string[]) =>
  as(people.manager).importCalendarFile({
    data: {
      calendarId: TEAM,
      file: calendarFile(
        "BEGIN:VEVENT",
        `UID:${FROM_A_FILE}`,
        ...lines,
        "END:VEVENT",
      ),
      timeZone: SYDNEY,
    },
  });

const WEEKLY_IN_A_FILE = [
  "DTSTART:20261109T220000Z",
  "DTEND:20261109T230000Z",
  "RRULE:FREQ=WEEKLY",
  "SUMMARY:Weekly planning",
];

test("deleting an event reaches a copy after a newer file replaced its changed dates", async () => {
  await importToTeam(...WEEKLY_IN_A_FILE);
  await change(FROM_A_FILE, { repeat: WEEKLY, people: [people.outsider] });
  await changeSecondDate(FROM_A_FILE);
  await importToTeam("SEQUENCE:2", ...WEEKLY_IN_A_FILE);
  await as(people.manager).deleteEvent({
    data: {
      calendarId: TEAM,
      target: { uid: FROM_A_FILE, occurrenceId: null },
      scope: "all",
    },
  });
  await objects.settle();
  const entries = await seen(people.outsider);
  expect(entries).toHaveLength(4);
  expect(entries.every((entry) => entry.cancelled)).toBe(true);
});

test("a file that calls off one date reaches every copy", async () => {
  await importToTeam(...WEEKLY_IN_A_FILE);
  await change(FROM_A_FILE, { repeat: WEEKLY, people: [people.outsider] });
  await importToTeam(
    `RECURRENCE-ID:${SECOND}`,
    `DTSTART:${SECOND}`,
    "SEQUENCE:5",
    "STATUS:CANCELLED",
  );
  await objects.settle();
  expect(
    (await seen(people.outsider)).map((entry) => [
      entry.occurrenceId,
      entry.cancelled,
    ]),
  ).toEqual([
    ["20261109T220000Z", false],
    [SECOND, true],
    [THIRD, false],
    ["20261130T220000Z", false],
  ]);
});

test("someone taken off the list and invited again finds every date back on", async () => {
  const uid = await invite([people.outsider], { repeat: WEEKLY });
  await change(
    uid,
    {
      title: "Moved",
      time: timed("2026-11-17T14:00:00+11:00", "2026-11-17T15:00:00+11:00"),
      repeat: WEEKLY,
      people: [people.outsider],
    },
    { occurrenceId: SECOND, scope: "this" },
  );
  await change(uid, { repeat: WEEKLY, people: [] });
  expect((await seen(people.outsider)).every((entry) => entry.cancelled)).toBe(
    true,
  );

  await change(uid, { repeat: WEEKLY, people: [people.outsider] });
  expect(
    (await seen(people.outsider)).map((entry) => [
      entry.title,
      entry.cancelled,
    ]),
  ).toEqual([
    ["Weekly planning", false],
    ["Moved", false],
    ["Weekly planning", false],
    ["Weekly planning", false],
  ]);
});

test("someone invited again is asked again, and their answer reaches the organiser", async () => {
  const uid = await invite([people.outsider]);
  await answer(people.outsider, uid, "yes");
  await change(uid, { people: [] });
  await change(uid, { people: [people.outsider] });

  const [jos] = await seen(people.outsider);
  expect(jos).toMatchObject({ answer: "needsAnswer", cancelled: false });
  expect(answers(jos)).toEqual({ "Jo Okafor": "needsAnswer" });
  expect(answers((await seen(people.manager))[0])).toEqual({
    "Jo Okafor": "needsAnswer",
  });
  await answer(people.outsider, uid, "yes");
  expect(answers((await seen(people.manager))[0])).toEqual({
    "Jo Okafor": "yes",
  });
});

test("someone taken off and put back before their copy heard is asked again too", async () => {
  const uid = await invite([people.editor, people.outsider]);
  await answer(people.outsider, uid, "yes");
  await unsent(uid, { people: [people.editor] });
  await change(uid, { people: [people.editor, people.outsider] });

  const expected = { "Maya Chen": "needsAnswer", "Jo Okafor": "needsAnswer" };
  const [jos] = await seen(people.outsider);
  expect(jos?.answer).toBe("needsAnswer");
  expect(answers(jos)).toEqual(expected);
  expect(answers((await seen(people.manager))[0])).toEqual(expected);
});

test("an answer given again still reaches the organiser", async () => {
  const uid = await invite([people.outsider]);
  await answer(people.outsider, uid, "yes");
  // As if the organiser's calendar were restored to before Jo answered.
  objects
    .sqlite(TEAM)
    .run(
      "UPDATE event_people SET attendees = json_set(attendees, '$[0].answer', 'needsAnswer', '$[0].revision', 0)",
    );
  await answer(people.outsider, uid, "yes");
  expect(answers((await seen(people.manager))[0])).toEqual({
    "Jo Okafor": "yes",
  });
});

test("someone invited from two calendars with the same UID gets both invitations", async () => {
  // Maya sees the UID of the event she's invited to, and makes one of her own with it.
  const uid = await invite([people.editor]);
  const theirs = await as(people.editor).createTeamCalendar({
    data: { name: "Maya's team" },
  });
  await as(people.editor).importCalendarFile({
    data: {
      calendarId: theirs,
      file: calendarFile(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTART:20261109T220000Z",
        "DTEND:20261109T230000Z",
        "SUMMARY:Pay the invoice",
        "END:VEVENT",
      ),
      timeZone: SYDNEY,
    },
  });
  await as(people.editor).updateEvent({
    data: {
      calendarId: theirs,
      target: { uid, occurrenceId: null },
      scope: "all",
      draft: planning({ title: "Pay the invoice", people: [people.outsider] }),
    },
  });
  await objects.settle();
  await change(uid, { people: [people.editor, people.outsider] });

  const organisers = (await seen(people.outsider)).map((entry) => [
    entry.title,
    entry.organiser.kind === "colleague" ? entry.organiser.calendarId : null,
  ]);
  expect(organisers).toEqual([
    ["Pay the invoice", theirs],
    ["Weekly planning", TEAM],
  ]);
  await answer(people.outsider, uid, "yes");
  expect(answers((await seen(people.manager))[0])).toEqual({
    "Maya Chen": "needsAnswer",
    "Jo Okafor": "yes",
  });
});

test("someone's own imported event can share a UID with an invitation, and both show", async () => {
  const uid = await invite([people.outsider]);
  const summary = await as(people.outsider).importCalendarFile({
    data: {
      calendarId: await personalOf(people.outsider),
      file: calendarFile(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTART:20261110T220000Z",
        "DTEND:20261110T230000Z",
        "SUMMARY:My own planning",
        "END:VEVENT",
      ),
      timeZone: SYDNEY,
    },
  });
  expect(summary).toMatchObject({ added: 1 });
  expect(
    (await seen(people.outsider)).map((entry) => [
      entry.title,
      entry.organiser.kind,
    ]),
  ).toEqual([
    ["Weekly planning", "colleague"],
    ["My own planning", "madeHere"],
  ]);
});

test("a date removed from a copy stays removed when the organiser moves every date", async () => {
  const uid = await invite([people.outsider], { repeat: WEEKLY });
  const mine = await personalOf(people.outsider);
  const remove = async (occurrenceId: OccurrenceId, scope: ChangeScope) =>
    as(people.outsider).deleteEvent({
      data: {
        calendarId: mine,
        target: { uid: await copyIn(people.outsider, uid), occurrenceId },
        scope,
      },
    });
  const dates = async () =>
    (await seen(people.outsider)).map((entry) => entry.occurrenceId);

  await remove(SECOND, "this");
  await change(uid, { time: LATER, repeat: WEEKLY, people: [people.outsider] });
  expect(await dates()).toEqual([
    "20261110T000000Z",
    "20261124T000000Z",
    "20261201T000000Z",
  ]);

  await remove("20261124T000000Z" as OccurrenceId, "thisAndLater");
  await change(uid, { repeat: WEEKLY, people: [people.outsider] });
  expect(await dates()).toEqual(["20261109T220000Z"]);
});

test("while Calendar is off, invitations and answers wait, and go once it's back on", async () => {
  const calendarOn = (on: boolean) =>
    kit.sqlite.run(
      on
        ? "DELETE FROM app_settings WHERE app = 'calendar'"
        : "INSERT INTO app_settings (app, enabled) VALUES ('calendar', 0)",
    );
  // Runs this calendar's next wake-up, which must be later, not now.
  const wakeLater = async (calendarId: CalendarId) => {
    const next = objects.alarmOf(calendarId);
    expect(next).toBeGreaterThan(Date.now());
    setSystemTime(new Date(next!));
    await objects.settle();
  };
  try {
    const uid = await as(people.manager).createEvent({
      data: {
        calendarId: TEAM,
        draft: planning({ people: [people.outsider] }),
      },
    });
    calendarOn(false);
    await objects.settle();
    expect(
      kit.sqlite
        .query("SELECT id FROM calendars WHERE owner_id = ?")
        .all(people.outsider),
    ).toEqual([]);
    calendarOn(true);
    await wakeLater(TEAM);
    expect((await seen(people.outsider)).map((entry) => entry.title)).toEqual([
      "Weekly planning",
    ]);

    const mine = await personalOf(people.outsider);
    await as(people.outsider).answerInvitation({
      data: {
        calendarId: mine,
        uid: await copyIn(people.outsider, uid),
        answer: "yes",
      },
    });
    calendarOn(false);
    await objects.settle();
    calendarOn(true);
    expect(answers((await seen(people.manager))[0])).toEqual({
      "Jo Okafor": "needsAnswer",
    });
    await wakeLater(mine);
    expect(answers((await seen(people.manager))[0])).toEqual({
      "Jo Okafor": "yes",
    });
  } finally {
    setSystemTime();
  }
});

test("someone whose calendar can't be reached is tried again every hour, and nobody else waits", async () => {
  const theirs = await as(people.outsider).ensureMyCalendar();
  objects.unreachable.add(theirs);
  try {
    const uid = await invite([people.outsider, people.editor]);
    for (let tries = 0; tries < 12; tries++) {
      const retry = objects.alarmOf(TEAM)!;
      expect(retry - Date.now()).toBeLessThanOrEqual(60 * 60_000);
      setSystemTime(new Date(retry));
      await objects.settle();
    }
    await change(uid, {
      title: "Planning, moved",
      people: [people.outsider, people.editor],
    });
    await invite([people.editor], { title: "Board review" });
    expect((await seen(people.editor)).map((entry) => entry.title)).toEqual([
      "Board review",
      "Planning, moved",
    ]);
    expect(await seen(people.outsider)).toEqual([]);
    expect(objects.alarmOf(TEAM)).toBeGreaterThan(Date.now());
  } finally {
    setSystemTime();
  }
});
