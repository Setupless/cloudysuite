import {
  afterEach,
  beforeEach,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import {
  type CalendarId,
  ensurePersonalCalendar,
  type UserId,
} from "@cloudysuite/access";
import { applyMigrations } from "@cloudysuite/object-sql";
import { createSqlDriver } from "@cloudysuite/object-sql/test-driver";
import type { CalendarClient } from "./client";
import { findEvents } from "./event-search";
import { MIGRATIONS } from "./migrations";
import { type OpenCalendar, searchCalendars } from "./across-calendars";
import { parseEventSearch } from "./search-query";
import {
  ALICE,
  BOB,
  createCalendarTest,
  date,
  draft,
  SYDNEY,
  TEAM,
} from "./test-support";
import type {
  EventDraft,
  EventSearchResult,
  EventTime,
  EventUid,
  Occurrence,
  OccurrenceId,
  Repeat,
  TimeZone,
} from "./types";

type Kit = Awaited<ReturnType<typeof createCalendarTest>>;
let kit: Kit;
let alice: CalendarClient;

const NOW = Date.parse("2026-11-05T10:00:00+11:00");

beforeEach(async () => {
  setSystemTime(NOW);
  kit = await createCalendarTest();
  alice = await kit.as(ALICE);
});

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

const at = (day: string, hour = "09:00", length = 1) => {
  const start = Date.parse(`${day}T${hour}:00+11:00`);
  return {
    kind: "timed",
    start,
    end: start + length * 3_600_000,
    timeZone: SYDNEY,
  } satisfies EventTime;
};

async function add(
  title: string,
  time: EventTime = at("2026-11-10"),
  more: Partial<EventDraft> = {},
  client: CalendarClient = alice,
): Promise<EventUid> {
  const result = await client.create(
    "Alice Stone",
    draft(time, { title, ...more }),
    [],
  );
  if (result.status !== "created") throw new Error(result.status);
  return result.uid;
}

const termsOf = (text: string) => {
  const parsed = parseEventSearch(text);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.terms;
};

const titles = async (text: string, client: CalendarClient = alice) =>
  (await client.search(termsOf(text), SYDNEY)).occurrences
    .map((occurrence) => occurrence.title)
    .sort();

const shownAs = (occurrences: Occurrence[]) =>
  occurrences.map((occurrence) => [
    occurrence.title,
    occurrence.time.kind === "timed"
      ? new Date(occurrence.time.start).toISOString()
      : occurrence.time.startDate,
  ]);

test("each word must start a word, in any order, in the title, place, or notes", async () => {
  await add("Spring launch review", at("2026-11-10"), {
    location: "Harbour room",
    notes: "Bring the budget figures",
  });
  await add("Board papers");

  expect(await titles("spr")).toEqual(["Spring launch review"]);
  expect(await titles("laun spr")).toEqual(["Spring launch review"]);
  expect(await titles("harb")).toEqual(["Spring launch review"]);
  expect(await titles("budget figu")).toEqual(["Spring launch review"]);
  expect(await titles("review harbour")).toEqual(["Spring launch review"]);
  expect(await titles("pring")).toEqual([]);
  expect(await titles("spring board")).toEqual([]);
});

test("case and accents don't matter, whichever way round", async () => {
  await add("Été Résumé");
  await add("Ñandú ДОКЛАД");
  await add("Café opening", at("2026-11-10"), { location: "Zürich" });
  for (const text of ["ete", "ÉTÉ", "resu", "RÉSUMÉ", "résumé"]) {
    expect(await titles(text)).toEqual(["Été Résumé"]);
  }
  for (const text of ["nandu", "ÑANDÚ", "доклад", "докл"]) {
    expect(await titles(text)).toEqual(["Ñandú ДОКЛАД"]);
  }
  expect(await titles("cafe")).toEqual(["Café opening"]);
  expect(await titles("CAFÉ")).toEqual(["Café opening"]);
  expect(await titles("zurich")).toEqual(["Café opening"]);
});

test("Chinese and Japanese match only from the start of a run of characters", async () => {
  await add("季度预算会议");
  await add("会議室の予約");
  await add("東京 出張");
  expect(await titles("季度")).toEqual(["季度预算会议"]);
  expect(await titles("预算")).toEqual([]);
  expect(await titles("会議")).toEqual(["会議室の予約"]);
  expect(await titles("予約")).toEqual([]);
  expect(await titles("出張")).toEqual(["東京 出張"]);
  expect(await titles("東京")).toEqual(["東京 出張"]);
});

test("no text reaches the index as syntax, and none can cause an error", async () => {
  await add("Quarterly report");
  await add("OR NOT AND");
  await add("NEAR miss");
  const hostile = [
    "",
    "   ",
    '"',
    '""',
    '"unterminated',
    "*",
    "report*",
    "NEAR(",
    "NEAR(a b)",
    "OR",
    "AND",
    "NOT",
    "a OR b",
    "report NOT quarterly",
    "title:report",
    "{title}: report",
    "- report",
    "^report",
    "(",
    ")",
    "'; DROP TABLE events; --",
    "\0",
    "report\0",
    "🎉",
    "́",
    "\ud83d",
    "𞤀𞤁",
    "ab𞤀cd",
    "a ".repeat(500),
    "x".repeat(10_000),
  ];
  for (const text of hostile) {
    const parsed = parseEventSearch(text);
    if (!parsed.ok) continue;
    await expect(alice.search(parsed.terms, SYDNEY)).resolves.toBeDefined();
  }
  expect(parseEventSearch('"').ok).toBe(false);
  expect(parseEventSearch("a ".repeat(500)).ok).toBe(false);
  expect(parseEventSearch("x".repeat(10_000)).ok).toBe(false);
  expect(await titles("report*")).toEqual(["Quarterly report"]);
  expect(await titles("title:report")).toEqual([]);
  expect(await titles("NOT")).toEqual(["OR NOT AND"]);
  expect(await titles("NEAR(")).toEqual(["NEAR miss"]);
  expect(kit.sqlite().query("SELECT count(*) AS n FROM events").all()).toEqual([
    { n: 3 },
  ]);
});

test("events still to come lead, soonest first, then past ones, newest first", async () => {
  await add("Review last month", at("2026-10-05"));
  await add("Review yesterday", at("2026-11-04"));
  await add("Review next week", at("2026-11-12"));
  await add("Review tomorrow", at("2026-11-06"));
  await add("Review going on now", at("2026-11-05", "09:30"));
  await add("Review all day tomorrow", {
    kind: "allDay",
    startDate: date("2026-11-06"),
    endDate: date("2026-11-07"),
  });

  const { occurrences } = await alice.search(termsOf("review"), SYDNEY);
  expect(occurrences.map((occurrence) => occurrence.title)).toEqual([
    "Review going on now",
    "Review all day tomorrow",
    "Review tomorrow",
    "Review next week",
    "Review yesterday",
    "Review last month",
  ]);
});

const weekly = (end: Repeat["end"] = { kind: "never" }): Repeat => ({
  frequency: "weekly",
  end,
});

test("a repeat shows once, at its next date, or its last date once it has ended", async () => {
  await add("Standup", at("2026-10-08", "09:00"), { repeat: weekly() });
  await add("Old course", at("2026-08-03"), {
    repeat: weekly({ kind: "afterTimes", times: 3 }),
  });

  const { occurrences } = await alice.search(termsOf("standup"), SYDNEY);
  expect(shownAs(occurrences)).toEqual([
    [
      "Standup",
      new Date(Date.parse("2026-11-12T09:00:00+11:00")).toISOString(),
    ],
  ]);
  expect(occurrences[0]?.occurrenceId).toBe("20261111T220000Z" as OccurrenceId);

  const ended = await alice.search(termsOf("course"), SYDNEY);
  expect(shownAs(ended.occurrences)).toEqual([
    ["Old course", "2026-08-16T22:00:00.000Z"],
  ]);
});

test("a changed date is found by its own details, and the series skips it", async () => {
  const uid = await add("Standup", at("2026-11-05", "11:00"), {
    repeat: weekly(),
  });
  const thisWeek = "20261105T000000Z" as OccurrenceId;
  expect(
    await alice.update(
      { uid, occurrenceId: thisWeek },
      "this",
      draft(at("2026-11-05", "15:00"), { title: "Standup with guests" }),
      [],
    ),
  ).toEqual({ status: "done" });

  const guests = await alice.search(termsOf("guests"), SYDNEY);
  expect(shownAs(guests.occurrences)).toEqual([
    [
      "Standup with guests",
      new Date(Date.parse("2026-11-05T15:00:00+11:00")).toISOString(),
    ],
  ]);
  expect(guests.occurrences[0]?.occurrenceId).toBe(thisWeek);

  // Both match "standup", and the changed date comes first.
  const both = await alice.search(termsOf("standup"), SYDNEY);
  expect(shownAs(both.occurrences)).toEqual([
    [
      "Standup with guests",
      new Date(Date.parse("2026-11-05T15:00:00+11:00")).toISOString(),
    ],
  ]);

  expect(await alice.remove({ uid, occurrenceId: thisWeek }, "this")).toEqual({
    status: "done",
  });
  expect(
    shownAs((await alice.search(termsOf("standup"), SYDNEY)).occurrences),
  ).toEqual([
    [
      "Standup",
      new Date(Date.parse("2026-11-12T11:00:00+11:00")).toISOString(),
    ],
  ]);
  expect(await titles("guests")).toEqual([]);
});

test("an edit shows at once: the old words stop matching and the new ones start", async () => {
  const uid = await add("Budget review", at("2026-11-10"), {
    location: "Room 4",
  });
  expect(
    await alice.update(
      { uid, occurrenceId: null },
      "all",
      draft(at("2026-11-10"), {
        title: "Hiring plan",
        location: "Harbour room",
        notes: "Agenda attached",
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(await titles("budget")).toEqual([]);
  expect(await titles("room 4")).toEqual([]);
  expect(await titles("hiring")).toEqual(["Hiring plan"]);
  expect(await titles("harbour")).toEqual(["Hiring plan"]);
  expect(await titles("agenda")).toEqual(["Hiring plan"]);

  expect(await alice.remove({ uid, occurrenceId: null }, "all")).toEqual({
    status: "done",
  });
  expect(await titles("hiring")).toEqual([]);
  expect(
    kit.sqlite().query("SELECT count(*) AS n FROM event_search").all(),
  ).toEqual([{ n: 0 }]);
});

test("when one calendar holds more matches than it answers with, the nearest stay", async () => {
  await add("Sync last week", at("2026-10-29"));
  for (let day = 1; day <= 52; day += 1) {
    const start = NOW + day * 86_400_000;
    await add(`Sync ${day}`, {
      kind: "timed",
      start,
      end: start + 3_600_000,
      timeZone: SYDNEY,
    });
  }
  const { occurrences, more } = await alice.search(termsOf("sync"), SYDNEY);
  expect(more).toBe(true);
  expect(occurrences).toHaveLength(50);
  expect(occurrences[0]?.title).toBe("Sync 1");
  expect(occurrences.at(-1)?.title).toBe("Sync 50");
});

test("repeats that take too long to work out say the answer is incomplete", async () => {
  for (const title of ["Ancient one", "Ancient two", "Ancient three"]) {
    await add(title, at("1900-01-01"), {
      repeat: { frequency: "daily", end: { kind: "never" } },
    });
  }
  expect((await alice.search(termsOf("ancient"), SYDNEY)).complete).toBe(false);
  const answer = await searchAll("ancient");
  expect(answer.incomplete).toBe(true);

  expect((await alice.search(termsOf("ancient one"), SYDNEY)).complete).toBe(
    true,
  );
  // Each search walks the whole step budget, which takes about 5 s on CI's runners.
}, 30_000);

test("events from before search existed are found, and stay in step afterwards", () => {
  const { db } = createSqlDriver();
  const insert = (uid: string, title: string, organiser: object) =>
    db.exec(
      `INSERT INTO events (uid, title, location, notes, starts_at, ends_at, tzid,
         organiser, sequence, created_at, updated_at, span_start, span_end)
       VALUES (?, ?, 'Level 2', 'Bring pens', ?, ?, ?, ?, 0, 1, 1, ?, ?)`,
      uid,
      title,
      NOW + 3_600_000,
      NOW + 7_200_000,
      SYDNEY,
      JSON.stringify(organiser),
      NOW + 3_600_000,
      NOW + 7_200_000,
    );
  applyMigrations(db, MIGRATIONS.slice(0, 1));
  insert("old-one", "Old Résumés review", { kind: "madeHere", userId: ALICE });
  applyMigrations(db, MIGRATIONS.slice(0, 2));
  insert("named-one", "Quarterly planning", {
    kind: "madeHere",
    userId: ALICE,
    name: "Alice Stone",
  });
  applyMigrations(db, MIGRATIONS);

  const actor = { userId: ALICE, role: "manager" as const, calendarId: TEAM };
  const found = (text: string) =>
    findEvents(db, actor, termsOf(text), SYDNEY, NOW).occurrences;
  const titles = (text: string) =>
    found(text).map((occurrence) => occurrence.title);
  expect(titles("resumes")).toEqual(["Old Résumés review"]);
  expect(titles("planning")).toEqual(["Quarterly planning"]);
  expect(titles("level").sort()).toEqual([
    "Old Résumés review",
    "Quarterly planning",
  ]);
  expect(titles("pens")).toHaveLength(2);
  expect(found("resumes")[0]!.organiser).toEqual({
    kind: "madeHere",
    userId: ALICE,
    name: null,
  });
  expect(found("planning")[0]!.organiser).toEqual({
    kind: "madeHere",
    userId: ALICE,
    name: "Alice Stone",
  });
  db.exec("UPDATE events SET title = 'New hire lunch' WHERE uid = 'old-one'");
  expect(titles("resumes")).toEqual([]);
  expect(titles("lunch")).toEqual(["New hire lunch"]);
});

// Across calendars.

const SALES = "2c4e5f60-bd3e-4a01-8f88-3d4e5f607182" as CalendarId;

function teamCalendar(id: CalendarId, name: string) {
  kit.directory.run(
    "INSERT INTO calendars (id, kind, name, colour) VALUES (?, 'team', ?, 1)",
    [id, name],
  );
}

function addTo(calendarId: CalendarId, userId: UserId, role = "manager") {
  kit.directory.run(
    "INSERT INTO calendar_access (calendar_id, user_id, role) VALUES (?, ?, ?)",
    [calendarId, userId, role],
  );
}

const opener =
  (userId: UserId): OpenCalendar =>
  (calendarId) =>
    kit.as(userId, calendarId);

const aliceAsPerson = { id: ALICE, name: "Alice Stone" };

const searchAll = (
  text: string,
  open: OpenCalendar = opener(ALICE),
  zone: TimeZone = SYDNEY,
) => searchCalendars(kit.d1, aliceAsPerson, open, termsOf(text), zone);

const calendarsOf = (answer: Awaited<ReturnType<typeof searchAll>>) =>
  answer.occurrences.map((occurrence) => [
    occurrence.title,
    occurrence.calendarId,
  ]);

test("search looks across every calendar the person sees, and nothing else", async () => {
  const personal = await ensurePersonalCalendar(kit.d1, ALICE);
  await add(
    "Planning lunch",
    at("2026-11-07"),
    {},
    await kit.as(ALICE, personal),
  );
  await add("Planning offsite", at("2026-11-08"));
  teamCalendar(SALES, "Sales");
  addTo(SALES, BOB);
  await add(
    "Planning sales kickoff",
    at("2026-11-06"),
    {},
    await kit.as(BOB, SALES),
  );

  const answer = await searchAll("planning");
  expect(calendarsOf(answer)).toEqual([
    ["Planning lunch", personal],
    ["Planning offsite", TEAM],
  ]);
  expect(answer.incomplete).toBe(false);
});

test("a hidden calendar is left out of search", async () => {
  await add("Planning offsite", at("2026-11-08"));
  teamCalendar(SALES, "Sales");
  addTo(SALES, ALICE, "editor");
  await add(
    "Planning sales kickoff",
    at("2026-11-06"),
    {},
    await kit.as(ALICE, SALES),
  );
  expect(calendarsOf(await searchAll("planning"))).toEqual([
    ["Planning sales kickoff", SALES],
    ["Planning offsite", TEAM],
  ]);

  kit.directory.run(
    "UPDATE calendar_access SET hidden = 1 WHERE calendar_id = ? AND user_id = ?",
    [TEAM, ALICE],
  );
  expect(calendarsOf(await searchAll("planning"))).toEqual([
    ["Planning sales kickoff", SALES],
  ]);
});

test("being refused part way through isn't a failure", async () => {
  await add("Planning offsite", at("2026-11-08"));
  teamCalendar(SALES, "Sales");
  addTo(SALES, ALICE, "viewer");
  const answer = await searchAll("planning", async (calendarId) => {
    if (calendarId === SALES) throw new Response(null, { status: 403 });
    return opener(ALICE)(calendarId);
  });
  expect(answer.incomplete).toBe(false);
  expect(calendarsOf(answer)).toEqual([["Planning offsite", TEAM]]);
});

test("a calendar that fails leaves the others' results and says so", async () => {
  await add("Planning offsite", at("2026-11-08"));
  teamCalendar(SALES, "Sales");
  addTo(SALES, ALICE, "viewer");
  const answer = await searchAll("planning", async (calendarId) => {
    if (calendarId === SALES) throw new Error("The object is unavailable");
    return opener(ALICE)(calendarId);
  });
  expect(answer.incomplete).toBe(true);
  expect(calendarsOf(answer)).toEqual([["Planning offsite", TEAM]]);
});

const DEADLINE_MS = 5_000;

// The calendars that answer do so in microtasks, so the clock moves only once they have.
async function waited<Answer>(
  asking: Promise<Answer>,
): Promise<{ answer: Answer; afterMs: number }> {
  let answer: { value: Answer } | null = null;
  void asking.then((value) => {
    answer = { value };
  });
  let afterMs = 0;
  for (;;) {
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    if (answer) return { answer: (answer as { value: Answer }).value, afterMs };
    if (afterMs > 60_000) throw new Error("It never answered.");
    jest.advanceTimersByTime(1_000);
    afterMs += 1_000;
  }
}

const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function moreCalendars(count: number): CalendarId[] {
  return Array.from({ length: count }, () => {
    const id = crypto.randomUUID() as CalendarId;
    teamCalendar(id, "More");
    addTo(id, ALICE, "viewer");
    return id;
  });
}

const slowed =
  (delays: ReadonlyMap<CalendarId, number | "never">): OpenCalendar =>
  async (calendarId) => {
    const client = await opener(ALICE)(calendarId);
    const delay = delays.get(calendarId);
    if (delay === undefined) return client;
    return {
      ...client,
      search: async (...args): Promise<EventSearchResult> => {
        if (delay === "never") return new Promise<never>(() => {});
        await after(delay);
        return client.search(...args);
      },
    };
  };

test("asking stops after 5 seconds, keeps what answered, and says some calendars are missing", async () => {
  await add("Planning offsite", at("2026-11-08"));
  teamCalendar(SALES, "Sales");
  addTo(SALES, ALICE, "editor");
  await add("Planning late", at("2026-11-06"), {}, await kit.as(ALICE, SALES));
  const fourSeconds = moreCalendars(6);
  jest.useFakeTimers();
  setSystemTime(NOW);
  const { answer, afterMs } = await waited(
    searchAll(
      "planning",
      slowed(
        new Map<CalendarId, number | "never">([
          [SALES, 6_000],
          ...fourSeconds.map((id) => [id, 4_000] as const),
        ]),
      ),
    ),
  );
  expect(afterMs).toBe(DEADLINE_MS);
  expect(answer.incomplete).toBe(true);
  expect(calendarsOf(answer)).toEqual([["Planning offsite", TEAM]]);
});

test("however many calendars are stuck, the answer comes after 5 seconds", async () => {
  await add("Planning offsite", at("2026-11-08"));
  const stuck = moreCalendars(8);
  jest.useFakeTimers();
  setSystemTime(NOW);
  const { answer, afterMs } = await waited(
    searchAll(
      "planning",
      slowed(new Map(stuck.map((id) => [id, "never"] as const))),
    ),
  );
  expect(afterMs).toBe(DEADLINE_MS);
  expect(answer.incomplete).toBe(true);
  expect(calendarsOf(answer)).toEqual([["Planning offsite", TEAM]]);
});

test("calendars are asked five at a time", async () => {
  await add("Planning offsite", at("2026-11-08"));
  moreCalendars(12);
  let open = 0;
  let most = 0;
  const answer = await searchAll("planning", async (calendarId) => {
    const client = await opener(ALICE)(calendarId);
    return {
      ...client,
      search: async (...args) => {
        open += 1;
        most = Math.max(most, open);
        await after(1);
        const found = await client.search(...args);
        open -= 1;
        return found;
      },
    };
  });
  expect(calendarsOf(answer)).toEqual([["Planning offsite", TEAM]]);
  expect(most).toBe(5);
});

test("results across calendars keep the order: still to come, then past", async () => {
  teamCalendar(SALES, "Sales");
  addTo(SALES, ALICE);
  const sales = await kit.as(ALICE, SALES);
  await add("Plan past team", at("2026-11-01"));
  await add("Plan next team", at("2026-11-20"));
  await add("Plan past sales", at("2026-11-03"), {}, sales);
  await add("Plan next sales", at("2026-11-07"), {}, sales);
  const answer = await searchAll("plan");
  expect(answer.occurrences.map((occurrence) => occurrence.title)).toEqual([
    "Plan next sales",
    "Plan next team",
    "Plan past sales",
    "Plan past team",
  ]);
});
