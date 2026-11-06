import { beforeEach, expect, test } from "bun:test";
import { applyMigrations } from "@cloudysuite/object-sql";
import { createSqlDriver } from "@cloudysuite/object-sql/test-driver";
import { MIGRATIONS } from "./migrations";
import { EventStore } from "./store";
import {
  ALICE,
  BOB,
  createCalendarTest,
  date,
  draft,
  LONDON,
  SYDNEY,
  TEAM,
} from "./test-support";
import type {
  EmailAddress,
  EventTime,
  EventUid,
  Occurrence,
  OccurrenceId,
  Repeat,
  TimeZone,
} from "./types";

let kit: Awaited<ReturnType<typeof createCalendarTest>>;

beforeEach(async () => {
  kit = await createCalendarTest();
});

const timed = (start: string, end: string, timeZone = SYDNEY): EventTime => ({
  kind: "timed",
  start: Date.parse(start),
  end: Date.parse(end),
  timeZone,
});

const weekly = (end: Repeat["end"] = { kind: "never" }): Repeat => ({
  frequency: "weekly",
  end,
});

const range = (from: string, to: string, timeZone: TimeZone = SYDNEY) => ({
  from: date(from),
  to: date(to),
  timeZone,
});

function localTime(instant: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const shown = (occurrences: Occurrence[]) =>
  occurrences.map((occurrence) => {
    const { time } = occurrence;
    return [
      occurrence.title,
      time.kind === "timed"
        ? localTime(time.start, time.timeZone)
        : time.startDate,
    ];
  });

async function created(time: EventTime, more: Parameters<typeof draft>[1]) {
  const result = await (
    await kit.as(ALICE)
  ).create("Alice Stone", draft(time, more), []);
  if (result.status !== "created") throw new Error("expected an event");
  return result.uid;
}

const listed = async (from: string, to: string, timeZone?: TimeZone) =>
  (await kit.as(ALICE)).listRange(range(from, to, timeZone));

test("Can view sees a calendar's events but can't add, change, or remove one", async () => {
  const uid = await created(
    timed("2026-11-05T11:00:00+11:00", "2026-11-05T12:00:00+11:00"),
    { title: "Spring launch review" },
  );
  kit.join(BOB, "viewer");
  const bob = await kit.as(BOB);

  const seen = await bob.listRange(range("2026-11-05", "2026-11-06"));
  expect(shown(seen.occurrences)).toEqual([
    ["Spring launch review", "2026-11-05 11:00"],
  ]);
  expect(seen.occurrences[0]?.changeable).toBe(false);

  const change = draft(
    timed("2026-11-05T13:00:00+11:00", "2026-11-05T14:00:00+11:00"),
  );
  const target = { uid, occurrenceId: null };
  expect(await bob.create("Bob Lee", change, [])).toEqual({
    status: "noAccess",
  });
  expect(await bob.update(target, "all", change, [])).toEqual({
    status: "noAccess",
  });
  expect(await bob.remove(target, "all")).toEqual({ status: "noAccess" });
  expect(shown((await listed("2026-11-05", "2026-11-06")).occurrences)).toEqual(
    [["Spring launch review", "2026-11-05 11:00"]],
  );
});

test.each([
  ["Can edit", "editor"],
  ["Can view", "viewer"],
] as const)(
  "%s can't empty a calendar, even straight through its object",
  async (_, role) => {
    await created(
      timed("2026-11-05T11:00:00+11:00", "2026-11-05T12:00:00+11:00"),
      { title: "Spring launch review" },
    );
    kit.join(BOB, role);

    expect(await (await kit.as(BOB)).erase()).toEqual({ status: "noAccess" });
    expect(
      shown((await listed("2026-11-05", "2026-11-06")).occurrences),
    ).toEqual([["Spring launch review", "2026-11-05 11:00"]]);
  },
);

test("Can edit changes an event someone else made on the team calendar", async () => {
  const uid = await created(
    timed("2026-11-05T11:00:00+11:00", "2026-11-05T12:00:00+11:00"),
    {},
  );
  kit.join(BOB, "editor");
  const bob = await kit.as(BOB);
  const [seen] = (await bob.listRange(range("2026-11-05", "2026-11-06")))
    .occurrences;
  expect(seen?.changeable).toBe(true);
  expect(seen?.organiser).toEqual({
    kind: "madeHere",
    userId: ALICE,
    name: "Alice Stone",
  });

  expect(
    await bob.update(
      { uid, occurrenceId: null },
      "all",
      draft(timed("2026-11-05T15:00:00+11:00", "2026-11-05T16:00:00+11:00"), {
        title: "Moved by Bob",
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-05", "2026-11-06")).occurrences)).toEqual(
    [["Moved by Bob", "2026-11-05 15:00"]],
  );
});

test("a weekly 9:00 meeting in Sydney stays at 9:00 there across the change to daylight saving", async () => {
  // Sydney moves from UTC+10 to UTC+11 on 4 October 2026.
  await created(
    timed("2026-09-21T09:00:00+10:00", "2026-09-21T09:30:00+10:00"),
    { repeat: weekly() },
  );
  const { occurrences } = await listed("2026-09-21", "2026-10-20");
  expect(occurrences.map((occurrence) => occurrence.time)).toEqual([
    timed("2026-09-21T09:00:00+10:00", "2026-09-21T09:30:00+10:00"),
    timed("2026-09-28T09:00:00+10:00", "2026-09-28T09:30:00+10:00"),
    timed("2026-10-05T09:00:00+11:00", "2026-10-05T09:30:00+11:00"),
    timed("2026-10-12T09:00:00+11:00", "2026-10-12T09:30:00+11:00"),
    timed("2026-10-19T09:00:00+11:00", "2026-10-19T09:30:00+11:00"),
  ]);

  // Someone in London asks for their own days and sees the same moments.
  const fromLondon = await listed("2026-10-04", "2026-10-06", LONDON);
  expect(
    fromLondon.occurrences.map((occurrence) =>
      occurrence.time.kind === "timed"
        ? localTime(occurrence.time.start, LONDON)
        : null,
    ),
  ).toEqual(["2026-10-04 23:00"]);
});

test("an all-day event is on the same day in every time zone", async () => {
  await created(
    {
      kind: "allDay",
      startDate: date("2026-12-25"),
      endDate: date("2026-12-26"),
    },
    { title: "Christmas Day" },
  );
  for (const zone of [SYDNEY, "America/Los_Angeles" as TimeZone]) {
    expect(
      shown((await listed("2026-12-25", "2026-12-26", zone)).occurrences),
    ).toEqual([["Christmas Day", "2026-12-25"]]);
    expect(
      (await listed("2026-12-24", "2026-12-25", zone)).occurrences,
    ).toEqual([]);
    expect(
      (await listed("2026-12-26", "2026-12-27", zone)).occurrences,
    ).toEqual([]);
  }
});

test("an event that spans several days shows on each of them", async () => {
  await created(
    timed("2026-11-06T18:00:00+11:00", "2026-11-08T12:00:00+11:00"),
    { title: "Retreat" },
  );
  await created(
    {
      kind: "allDay",
      startDate: date("2026-11-10"),
      endDate: date("2026-11-13"),
    },
    { title: "Trade show" },
  );
  expect(shown((await listed("2026-11-07", "2026-11-08")).occurrences)).toEqual(
    [["Retreat", "2026-11-06 18:00"]],
  );
  expect(shown((await listed("2026-11-12", "2026-11-13")).occurrences)).toEqual(
    [["Trade show", "2026-11-10"]],
  );
  expect((await listed("2026-11-13", "2026-11-14")).occurrences).toEqual([]);
});

test("a repeat ends on its last day or after its number of times", async () => {
  await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
    {
      title: "Until",
      repeat: weekly({ kind: "onDate", date: date("2026-11-16") }),
    },
  );
  await created(
    timed("2026-11-03T09:00:00+11:00", "2026-11-03T09:15:00+11:00"),
    { title: "Twice", repeat: weekly({ kind: "afterTimes", times: 2 }) },
  );
  expect(shown((await listed("2026-11-01", "2027-01-01")).occurrences)).toEqual(
    [
      ["Until", "2026-11-02 09:00"],
      ["Twice", "2026-11-03 09:00"],
      ["Until", "2026-11-09 09:00"],
      ["Twice", "2026-11-10 09:00"],
      ["Until", "2026-11-16 09:00"],
    ],
  );
});

test("a fortnightly event is on every other week, and splitting it keeps the rhythm from the chosen date", async () => {
  const fortnightly: Repeat = {
    frequency: "fortnightly",
    end: { kind: "afterTimes", times: 4 },
  };
  const uid = await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
    { title: "Pay run", repeat: fortnightly },
  );
  const { occurrences } = await listed("2026-11-01", "2027-02-01");
  expect(shown(occurrences)).toEqual([
    ["Pay run", "2026-11-02 09:00"],
    ["Pay run", "2026-11-16 09:00"],
    ["Pay run", "2026-11-30 09:00"],
    ["Pay run", "2026-12-14 09:00"],
  ]);
  expect(occurrences[0]?.repeat).toEqual(fortnightly);
  expect(occurrences[0]?.changeable).toBe(true);

  await (
    await kit.as(ALICE)
  ).update(
    { uid, occurrenceId: occurrences[2]!.occurrenceId },
    "thisAndLater",
    draft(timed("2026-12-01T09:00:00+11:00", "2026-12-01T09:15:00+11:00"), {
      title: "Pay run",
      repeat: fortnightly,
    }),
    [],
  );
  expect(shown((await listed("2026-11-01", "2027-02-01")).occurrences)).toEqual(
    [
      ["Pay run", "2026-11-02 09:00"],
      ["Pay run", "2026-11-16 09:00"],
      ["Pay run", "2026-12-01 09:00"],
      ["Pay run", "2026-12-15 09:00"],
    ],
  );
});

test("a fortnightly repeat from outside shows as Every fortnight and can be changed", async () => {
  kit.arrive({
    uid: "pay@example.net",
    title: "Pay run",
    start: Date.parse("2026-11-03T08:00:00+11:00"),
    end: Date.parse("2026-11-03T08:30:00+11:00"),
    timeZone: SYDNEY,
    rule: "FREQ=WEEKLY;INTERVAL=2;UNTIL=20261201T000000Z",
    organiser: { kind: "madeHere", userId: ALICE, name: "Alice Stone" },
  });
  const { occurrences } = await listed("2026-11-01", "2027-01-01");
  expect(shown(occurrences)).toEqual([
    ["Pay run", "2026-11-03 08:00"],
    ["Pay run", "2026-11-17 08:00"],
    ["Pay run", "2026-12-01 08:00"],
  ]);
  expect(occurrences[0]?.repeat).toEqual({
    frequency: "fortnightly",
    end: { kind: "onDate", date: date("2026-12-01") },
  });
  expect(occurrences[0]?.changeable).toBe(true);
});

test("a yearly event on 29 February is on 29 February in leap years only", async () => {
  await created(
    {
      kind: "allDay",
      startDate: date("2028-02-29"),
      endDate: date("2028-03-01"),
    },
    {
      title: "Leap birthday",
      repeat: { frequency: "yearly", end: { kind: "never" } },
    },
  );
  await created(
    timed("2028-02-29T09:00:00+11:00", "2028-02-29T10:00:00+11:00"),
    {
      title: "Leap review",
      repeat: { frequency: "yearly", end: { kind: "afterTimes", times: 2 } },
    },
  );
  expect(shown((await listed("2028-01-01", "2037-01-01")).occurrences)).toEqual(
    [
      ["Leap birthday", "2028-02-29"],
      ["Leap review", "2028-02-29 09:00"],
      ["Leap birthday", "2032-02-29"],
      ["Leap review", "2032-02-29 09:00"],
      ["Leap birthday", "2036-02-29"],
    ],
  );
});

test("an unbounded daily series gives at most 1,000 dates in one range", async () => {
  await created(
    timed("2026-01-01T09:00:00+11:00", "2026-01-01T09:15:00+11:00"),
    { repeat: { frequency: "daily", end: { kind: "never" } } },
  );
  const fiveYears = await listed("2026-01-01", "2031-01-01");
  expect(fiveYears.complete).toBe(false);
  expect(fiveYears.occurrences).toHaveLength(1000);
  expect(shown(fiveYears.occurrences.slice(0, 1))).toEqual([
    ["Team standup", "2026-01-01 09:00"],
  ]);
  // The thousandth day after 1 January 2026.
  expect(shown(fiveYears.occurrences.slice(-1))).toEqual([
    ["Team standup", "2028-09-26 09:00"],
  ]);

  const january = await listed("2026-01-01", "2026-02-01");
  expect(january.complete).toBe(true);
  expect(january.occurrences).toHaveLength(31);
});

test("changing only this one moves one date and leaves the rest", async () => {
  const uid = await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
    { repeat: weekly() },
  );
  const alice = await kit.as(ALICE);
  const second = "20261108T220000Z" as OccurrenceId;
  expect(
    await alice.update(
      { uid, occurrenceId: second },
      "this",
      draft(timed("2026-11-10T14:00:00+11:00", "2026-11-10T14:30:00+11:00"), {
        title: "Moved standup",
      }),
      [],
    ),
  ).toEqual({ status: "done" });

  const { occurrences } = await listed("2026-11-01", "2026-11-24");
  expect(shown(occurrences)).toEqual([
    ["Team standup", "2026-11-02 09:00"],
    ["Moved standup", "2026-11-10 14:00"],
    ["Team standup", "2026-11-16 09:00"],
    ["Team standup", "2026-11-23 09:00"],
  ]);
  expect(occurrences[1]?.occurrenceId).toBe(second);
});

test("renaming this and later ones keeps the later dates that were removed or moved", async () => {
  const uid = await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
    { repeat: weekly({ kind: "afterTimes", times: 6 }) },
  );
  const alice = await kit.as(ALICE);
  expect(
    await alice.remove(
      { uid, occurrenceId: "20261122T220000Z" as OccurrenceId },
      "this",
    ),
  ).toEqual({ status: "done" });
  expect(
    await alice.update(
      { uid, occurrenceId: "20261129T220000Z" as OccurrenceId },
      "this",
      draft(timed("2026-11-30T14:00:00+11:00", "2026-11-30T14:15:00+11:00"), {
        title: "Moved standup",
      }),
      [],
    ),
  ).toEqual({ status: "done" });

  expect(
    await alice.update(
      { uid, occurrenceId: "20261115T220000Z" as OccurrenceId },
      "thisAndLater",
      draft(timed("2026-11-16T09:00:00+11:00", "2026-11-16T09:15:00+11:00"), {
        title: "Renamed standup",
        repeat: weekly({ kind: "afterTimes", times: 6 }),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-01", "2027-01-01")).occurrences)).toEqual(
    [
      ["Team standup", "2026-11-02 09:00"],
      ["Team standup", "2026-11-09 09:00"],
      ["Renamed standup", "2026-11-16 09:00"],
      ["Moved standup", "2026-11-30 14:00"],
      ["Renamed standup", "2026-12-07 09:00"],
    ],
  );
});

// A weekly 9:00 to 10:00 standup with these dates removed and 30 November moved to 14:00.
async function standupWithDatesChangedAlone(
  removed: OccurrenceId[],
  movedTitle = "Moved standup",
) {
  const uid = await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T10:00:00+11:00"),
    { repeat: weekly() },
  );
  const alice = await kit.as(ALICE);
  for (const occurrenceId of removed) {
    expect(await alice.remove({ uid, occurrenceId }, "this")).toEqual({
      status: "done",
    });
  }
  expect(
    await alice.update(
      { uid, occurrenceId: "20261129T220000Z" as OccurrenceId },
      "this",
      draft(timed("2026-11-30T14:00:00+11:00", "2026-11-30T15:00:00+11:00"), {
        title: movedTitle,
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  return uid;
}

const NOVEMBER_23 = "20261122T220000Z" as OccurrenceId;
const NOVEMBER_30 = "20261129T220000Z" as OccurrenceId;

const shownWithEnds = (occurrences: Occurrence[]) =>
  occurrences.map((occurrence) => {
    const { time } = occurrence;
    if (time.kind !== "timed") throw new Error("expected a timed date");
    return [
      occurrence.title,
      `${localTime(time.start, time.timeZone)} to ${localTime(time.end, time.timeZone).slice(11)}`,
    ];
  });

test("renaming this and later ones renames a date moved on its own, and keeps a title changed on its own", async () => {
  const uid = await standupWithDatesChangedAlone([NOVEMBER_23], "Team standup");
  const alice = await kit.as(ALICE);
  expect(
    await alice.update(
      { uid, occurrenceId: "20261206T220000Z" as OccurrenceId },
      "this",
      draft(timed("2026-12-07T09:00:00+11:00", "2026-12-07T10:00:00+11:00"), {
        title: "Planning",
      }),
      [],
    ),
  ).toEqual({ status: "done" });

  expect(
    await alice.update(
      { uid, occurrenceId: "20261115T220000Z" as OccurrenceId },
      "thisAndLater",
      draft(timed("2026-11-16T09:00:00+11:00", "2026-11-16T10:00:00+11:00"), {
        title: "Daily sync",
        repeat: weekly(),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-01", "2026-12-21")).occurrences)).toEqual(
    [
      ["Team standup", "2026-11-02 09:00"],
      ["Team standup", "2026-11-09 09:00"],
      ["Daily sync", "2026-11-16 09:00"],
      ["Daily sync", "2026-11-30 14:00"],
      ["Planning", "2026-12-07 09:00"],
      ["Daily sync", "2026-12-14 09:00"],
    ],
  );
});

test("changing all of them from a date moved on its own shows the change on that date", async () => {
  const uid = await standupWithDatesChangedAlone([NOVEMBER_23], "Team standup");
  expect(
    await (
      await kit.as(ALICE)
    ).update(
      { uid, occurrenceId: NOVEMBER_30 },
      "all",
      draft(timed("2026-11-30T14:00:00+11:00", "2026-11-30T15:30:00+11:00"), {
        title: "Daily sync",
        repeat: weekly(),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(
    shownWithEnds((await listed("2026-11-01", "2026-12-14")).occurrences),
  ).toEqual([
    ["Daily sync", "2026-11-02 09:00 to 10:30"],
    ["Daily sync", "2026-11-09 09:00 to 10:30"],
    ["Daily sync", "2026-11-16 09:00 to 10:30"],
    ["Daily sync", "2026-11-30 14:00 to 15:30"],
    ["Daily sync", "2026-12-07 09:00 to 10:30"],
  ]);
});

test("moving the start of all of them keeps the removed date removed and the moved date where it went", async () => {
  const uid = await standupWithDatesChangedAlone([NOVEMBER_23]);
  expect(
    await (
      await kit.as(ALICE)
    ).update(
      { uid, occurrenceId: null },
      "all",
      draft(timed("2026-11-02T10:00:00+11:00", "2026-11-02T11:00:00+11:00"), {
        repeat: weekly(),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-01", "2026-12-14")).occurrences)).toEqual(
    [
      ["Team standup", "2026-11-02 10:00"],
      ["Team standup", "2026-11-09 10:00"],
      ["Team standup", "2026-11-16 10:00"],
      ["Moved standup", "2026-11-30 14:00"],
      ["Team standup", "2026-12-07 10:00"],
    ],
  );
});

test("moving the start of this and later ones keeps the removed date removed and the moved date where it went", async () => {
  const uid = await standupWithDatesChangedAlone([NOVEMBER_23]);
  expect(
    await (
      await kit.as(ALICE)
    ).update(
      { uid, occurrenceId: "20261115T220000Z" as OccurrenceId },
      "thisAndLater",
      draft(timed("2026-11-16T10:00:00+11:00", "2026-11-16T11:00:00+11:00"), {
        repeat: weekly(),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-01", "2026-12-14")).occurrences)).toEqual(
    [
      ["Team standup", "2026-11-02 09:00"],
      ["Team standup", "2026-11-09 09:00"],
      ["Team standup", "2026-11-16 10:00"],
      ["Moved standup", "2026-11-30 14:00"],
      ["Team standup", "2026-12-07 10:00"],
    ],
  );
});

test("renaming this and later ones from a date moved on its own keeps the later dates at the series' time", async () => {
  const uid = await standupWithDatesChangedAlone([], "Team standup");
  expect(
    await (
      await kit.as(ALICE)
    ).update(
      { uid, occurrenceId: NOVEMBER_30 },
      "thisAndLater",
      draft(timed("2026-11-30T14:00:00+11:00", "2026-11-30T15:00:00+11:00"), {
        title: "Daily sync",
        repeat: weekly(),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(
    shownWithEnds((await listed("2026-11-01", "2026-12-21")).occurrences),
  ).toEqual([
    ["Team standup", "2026-11-02 09:00 to 10:00"],
    ["Team standup", "2026-11-09 09:00 to 10:00"],
    ["Team standup", "2026-11-16 09:00 to 10:00"],
    ["Team standup", "2026-11-23 09:00 to 10:00"],
    ["Daily sync", "2026-11-30 14:00 to 15:00"],
    ["Daily sync", "2026-12-07 09:00 to 10:00"],
    ["Daily sync", "2026-12-14 09:00 to 10:00"],
  ]);
});

test("making this and later ones longer keeps the later dates that were removed or moved", async () => {
  const uid = await standupWithDatesChangedAlone([NOVEMBER_23]);
  expect(
    await (
      await kit.as(ALICE)
    ).update(
      { uid, occurrenceId: "20261115T220000Z" as OccurrenceId },
      "thisAndLater",
      draft(timed("2026-11-16T09:00:00+11:00", "2026-11-16T10:30:00+11:00"), {
        title: "Longer standup",
        repeat: weekly(),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-01", "2026-12-14")).occurrences)).toEqual(
    [
      ["Team standup", "2026-11-02 09:00"],
      ["Team standup", "2026-11-09 09:00"],
      ["Longer standup", "2026-11-16 09:00"],
      ["Moved standup", "2026-11-30 14:00"],
      ["Longer standup", "2026-12-07 09:00"],
    ],
  );
});

test("making all of them longer keeps the dates that were removed or moved", async () => {
  const uid = await standupWithDatesChangedAlone([NOVEMBER_23]);
  expect(
    await (
      await kit.as(ALICE)
    ).update(
      { uid, occurrenceId: null },
      "all",
      draft(timed("2026-11-02T09:00:00+11:00", "2026-11-02T10:30:00+11:00"), {
        title: "Longer standup",
        repeat: weekly(),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-01", "2026-12-14")).occurrences)).toEqual(
    [
      ["Longer standup", "2026-11-02 09:00"],
      ["Longer standup", "2026-11-09 09:00"],
      ["Longer standup", "2026-11-16 09:00"],
      ["Moved standup", "2026-11-30 14:00"],
      ["Longer standup", "2026-12-07 09:00"],
    ],
  );
});

test("ending all of them sooner drops the removed and moved dates past the new end, and keeps the rest", async () => {
  const uid = await standupWithDatesChangedAlone([
    "20261108T220000Z" as OccurrenceId,
    NOVEMBER_23,
  ]);
  expect(
    await (
      await kit.as(ALICE)
    ).update(
      { uid, occurrenceId: null },
      "all",
      draft(timed("2026-11-02T09:00:00+11:00", "2026-11-02T10:00:00+11:00"), {
        repeat: weekly({ kind: "onDate", date: date("2026-11-20") }),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-01", "2026-12-14")).occurrences)).toEqual(
    [
      ["Team standup", "2026-11-02 09:00"],
      ["Team standup", "2026-11-16 09:00"],
    ],
  );
});

test("this and later ones splits the series, and each half then changes alone", async () => {
  const uid = await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
    { repeat: weekly() },
  );
  const alice = await kit.as(ALICE);
  expect(
    await alice.update(
      { uid, occurrenceId: "20261115T220000Z" as OccurrenceId },
      "thisAndLater",
      draft(timed("2026-11-16T10:00:00+11:00", "2026-11-16T10:30:00+11:00"), {
        title: "Planning",
        repeat: weekly(),
      }),
      [],
    ),
  ).toEqual({ status: "done" });

  const { occurrences } = await listed("2026-11-01", "2026-12-01");
  expect(shown(occurrences)).toEqual([
    ["Team standup", "2026-11-02 09:00"],
    ["Team standup", "2026-11-09 09:00"],
    ["Planning", "2026-11-16 10:00"],
    ["Planning", "2026-11-23 10:00"],
    ["Planning", "2026-11-30 10:00"],
  ]);
  const [first, , later] = occurrences;
  expect(first?.repeat).toEqual(
    weekly({ kind: "onDate", date: date("2026-11-15") }),
  );
  expect(later?.uid).not.toBe(uid);

  expect(
    await alice.update(
      { uid, occurrenceId: first?.occurrenceId ?? null },
      "all",
      draft(first?.time as EventTime, {
        title: "Standup",
        repeat: first?.repeat as Repeat,
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-01", "2026-12-01")).occurrences)).toEqual(
    [
      ["Standup", "2026-11-02 09:00"],
      ["Standup", "2026-11-09 09:00"],
      ["Planning", "2026-11-16 10:00"],
      ["Planning", "2026-11-23 10:00"],
      ["Planning", "2026-11-30 10:00"],
    ],
  );
});

test("splitting a series that ends after ten times keeps ten dates in all", async () => {
  const uid = await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
    { repeat: weekly({ kind: "afterTimes", times: 10 }) },
  );
  await (
    await kit.as(ALICE)
  ).update(
    { uid, occurrenceId: "20261122T220000Z" as OccurrenceId },
    "thisAndLater",
    draft(timed("2026-11-23T09:00:00+11:00", "2026-11-23T09:15:00+11:00"), {
      title: "Later",
      repeat: weekly({ kind: "afterTimes", times: 10 }),
    }),
    [],
  );
  const { occurrences } = await listed("2026-11-01", "2027-06-01");
  expect(occurrences.map((occurrence) => occurrence.title)).toEqual([
    ...Array<string>(3).fill("Team standup"),
    ...Array<string>(7).fill("Later"),
  ]);
  expect(occurrences.at(-1)?.repeat).toEqual(
    weekly({ kind: "afterTimes", times: 7 }),
  );
});

test("this and later ones from the first date changes the whole series, and leaves no empty one", async () => {
  const uid = await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
    { repeat: weekly({ kind: "afterTimes", times: 4 }) },
  );
  const alice = await kit.as(ALICE);
  expect(
    await alice.update(
      { uid, occurrenceId: "20261101T220000Z" as OccurrenceId },
      "thisAndLater",
      draft(timed("2026-11-02T10:00:00+11:00", "2026-11-02T10:15:00+11:00"), {
        title: "Later",
        repeat: weekly({ kind: "afterTimes", times: 4 }),
      }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(shown((await listed("2026-11-01", "2026-12-01")).occurrences)).toEqual(
    [
      ["Later", "2026-11-02 10:00"],
      ["Later", "2026-11-09 10:00"],
      ["Later", "2026-11-16 10:00"],
      ["Later", "2026-11-23 10:00"],
    ],
  );
  expect(await alice.countEvents()).toBe(1);
});

test("removing this and later ones from the first date removes the event, and keeps its record", async () => {
  const uid = await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
    { repeat: weekly() },
  );
  const alice = await kit.as(ALICE);
  expect(
    await alice.remove(
      { uid, occurrenceId: "20261101T220000Z" as OccurrenceId },
      "thisAndLater",
    ),
  ).toEqual({ status: "done" });
  expect((await listed("2026-11-01", "2026-12-01")).occurrences).toEqual([]);
  expect(await alice.countEvents()).toBe(0);
  expect(
    kit.sqlite().query("SELECT uid, sequence FROM removed_events").all(),
  ).toEqual([{ uid, sequence: 0 }]);
});

test("removing one date, then later dates, then the rest", async () => {
  const uid = await created(
    timed("2026-11-02T09:00:00+11:00", "2026-11-02T09:15:00+11:00"),
    { repeat: weekly() },
  );
  const alice = await kit.as(ALICE);
  await alice.remove(
    { uid, occurrenceId: "20261108T220000Z" as OccurrenceId },
    "this",
  );
  await alice.remove(
    { uid, occurrenceId: "20261122T220000Z" as OccurrenceId },
    "thisAndLater",
  );
  expect(shown((await listed("2026-11-01", "2027-01-01")).occurrences)).toEqual(
    [
      ["Team standup", "2026-11-02 09:00"],
      ["Team standup", "2026-11-16 09:00"],
    ],
  );
  expect(
    await alice.remove(
      { uid, occurrenceId: "20261108T220000Z" as OccurrenceId },
      "this",
    ),
  ).toEqual({ status: "gone" });
});

test("deleting an event keeps its UID and sequence, so the same copy can't come back", async () => {
  const uid = await created(
    timed("2026-11-05T11:00:00+11:00", "2026-11-05T12:00:00+11:00"),
    {},
  );
  const alice = await kit.as(ALICE);
  const later = draft(
    timed("2026-11-05T13:00:00+11:00", "2026-11-05T14:00:00+11:00"),
  );
  await alice.update({ uid, occurrenceId: null }, "all", later, []);
  await alice.update({ uid, occurrenceId: null }, "all", later, []);
  expect(await alice.remove({ uid, occurrenceId: null }, "all")).toEqual({
    status: "done",
  });

  expect((await listed("2026-11-05", "2026-11-06")).occurrences).toEqual([]);
  expect(
    kit.sqlite().query("SELECT uid, sequence FROM removed_events").all(),
  ).toEqual([{ uid, sequence: 2 }]);
  expect(
    await alice.update({ uid, occurrenceId: null }, "all", later, []),
  ).toEqual({ status: "gone" });
});

test("an invitation from someone else can be removed but not changed", async () => {
  kit.arrive({
    uid: "invite@example.net",
    title: "Supplier call",
    start: Date.parse("2026-11-10T15:00:00+11:00"),
    end: Date.parse("2026-11-10T15:30:00+11:00"),
    timeZone: SYDNEY,
    rule: null,
    organiser: {
      kind: "outside",
      email: "jo@example.net" as EmailAddress,
      name: "Jo",
      uid: "invite@example.net" as EventUid,
      fromOrganiser: true,
    },
  });
  const alice = await kit.as(ALICE);
  const [seen] = (await listed("2026-11-10", "2026-11-11")).occurrences;
  expect(seen?.changeable).toBe(false);

  const target = { uid: seen!.uid, occurrenceId: null };
  expect(
    await alice.update(target, "all", draft(seen!.time, { title: "Mine" }), []),
  ).toEqual({ status: "readOnly" });
  expect(await alice.remove(target, "all")).toEqual({ status: "done" });
  expect((await listed("2026-11-10", "2026-11-11")).occurrences).toEqual([]);
});

test("a repeat from outside keeps its own dates, and can only be removed", async () => {
  kit.arrive({
    uid: "fortnightly@example.net",
    title: "Fortnightly",
    start: Date.parse("2026-11-03T08:00:00+11:00"),
    end: Date.parse("2026-11-03T08:30:00+11:00"),
    timeZone: SYDNEY,
    rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH",
    organiser: { kind: "madeHere", userId: ALICE, name: "Alice Stone" },
  });
  const alice = await kit.as(ALICE);
  const { occurrences } = await listed("2026-11-01", "2026-11-29");
  expect(shown(occurrences)).toEqual([
    ["Fortnightly", "2026-11-03 08:00"],
    ["Fortnightly", "2026-11-05 08:00"],
    ["Fortnightly", "2026-11-17 08:00"],
    ["Fortnightly", "2026-11-19 08:00"],
  ]);
  const [first, second] = occurrences;
  expect(first?.repeat).toEqual({ frequency: "custom" });
  expect(first?.changeable).toBe(false);

  const target = { uid: first!.uid, occurrenceId: second!.occurrenceId };
  expect(await alice.update(target, "this", draft(second!.time), [])).toEqual({
    status: "readOnly",
  });
  expect(await alice.remove(target, "thisAndLater")).toEqual({
    status: "readOnly",
  });
  expect(await alice.remove(target, "this")).toEqual({ status: "done" });
  expect(
    shown((await listed("2026-11-01", "2026-11-29")).occurrences),
  ).toHaveLength(3);
});

test("an event made before names were kept still shows, and can still be changed", () => {
  const { db } = createSqlDriver();
  applyMigrations(db, MIGRATIONS.slice(0, 1));
  const start = Date.parse("2026-11-05T11:00:00+11:00");
  const end = start + 3_600_000;
  db.exec(
    `INSERT INTO events (uid, title, location, notes, starts_at, ends_at, tzid,
       organiser, sequence, created_at, updated_at, span_start, span_end)
     VALUES ('old', 'Older review', '', '', ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    start,
    end,
    SYDNEY,
    JSON.stringify({ kind: "madeHere", userId: ALICE }),
    start,
    end,
  );
  applyMigrations(db, MIGRATIONS);

  const store = new EventStore(db);
  const alice = { userId: ALICE, role: "manager" as const, calendarId: TEAM };
  const [seen] = store.listRange(
    alice,
    range("2026-11-05", "2026-11-06"),
  ).occurrences;
  expect(seen).toMatchObject({
    title: "Older review",
    organiser: { kind: "madeHere", userId: ALICE, name: null },
    changeable: true,
  });
  expect(
    store.update(
      alice,
      { uid: seen!.uid, occurrenceId: null },
      "all",
      draft(seen!.time, { title: "Older review, renamed" }),
      [],
      "ready",
      0,
    ),
  ).toEqual({ status: "done" });
  expect(
    store.listRange(alice, range("2026-11-05", "2026-11-06")).occurrences[0]
      ?.title,
  ).toBe("Older review, renamed");
});
