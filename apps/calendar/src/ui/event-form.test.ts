import { beforeEach, expect, test } from "bun:test";
import {
  ALICE,
  createCalendarTest,
  date,
  LONDON,
  SYDNEY,
} from "../test-support";
import type { Occurrence, OccurrenceId } from "../types";
import {
  draftOf,
  type EventForm,
  formOf,
  newForm,
  nextHalfHour,
  scopesFor,
  slotStart,
  withStart,
} from "./event-form";

let kit: Awaited<ReturnType<typeof createCalendarTest>>;

beforeEach(async () => {
  kit = await createCalendarTest();
});

const base = newForm({ date: date("2026-11-05"), minute: 15 * 60 }, SYDNEY);
const form = (more: Partial<EventForm>): EventForm => ({
  ...base,
  title: "Product demo",
  ...more,
});

function drafted(filled: EventForm) {
  const checked = draftOf(filled, SYDNEY);
  if (!checked.ok) throw new Error(checked.message);
  return checked.draft;
}

// Saves through the real Calendar object, then reads the event back the way Edit does.
async function savedAndOpened(filled: EventForm): Promise<Occurrence> {
  const alice = await kit.as(ALICE);
  const result = await alice.create("Alice Stone", drafted(filled), []);
  if (result.status !== "created") throw new Error("expected an event");
  const { occurrences } = await alice.listRange({
    from: date("2026-11-01"),
    to: date("2027-01-01"),
    timeZone: SYDNEY,
  });
  return occurrences[0]!;
}

test.each([
  [
    "a timed event with a place and notes, every week",
    form({
      location: "Meeting room 2",
      notes: "Bring the press list.\nhttps://example.com/deck",
      repeat: "weekly",
    }),
  ],
  [
    "an all-day event over three days, every year five times",
    form({
      allDay: true,
      endDate: "2026-11-07",
      repeat: "yearly",
      repeatEnd: "afterTimes",
      repeatTimes: "5",
    }),
  ],
  [
    "an overnight event, every day until a day",
    form({
      startTime: "22:00",
      endDate: "2026-11-06",
      endTime: "01:30",
      repeat: "daily",
      repeatEnd: "onDate",
      repeatUntil: "2026-11-20",
    }),
  ],
  [
    "a three-day timed event, every weekday",
    form({ endDate: "2026-11-07", endTime: "17:00", repeat: "weekdays" }),
  ],
  [
    "an event every month, twelve times",
    form({ repeat: "monthly", repeatEnd: "afterTimes", repeatTimes: "12" }),
  ],
])("%s opens in Edit just as it was saved", async (_, filled) => {
  const opened = formOf(await savedAndOpened(filled), SYDNEY);
  expect(drafted(opened)).toEqual(drafted(filled));
  // An all-day event has no times to show, so its hidden ones aren't kept.
  const shown = ({ startTime, endTime, ...rest }: EventForm) =>
    filled.allDay ? rest : { startTime, endTime, ...rest };
  expect(shown(opened)).toEqual(shown(filled));
});

test("a click on an empty slot starts there, on its half hour, for an hour", () => {
  const filled = {
    ...newForm(slotStart(date("2026-11-04"), 13 * 60 + 40), SYDNEY),
    title: "Lunch",
  };
  expect(filled).toMatchObject({
    startDate: "2026-11-04",
    startTime: "13:30",
    endDate: "2026-11-04",
    endTime: "14:30",
  });
  expect(drafted(filled).time).toEqual({
    kind: "timed",
    start: Date.parse("2026-11-04T13:30:00+11:00"),
    end: Date.parse("2026-11-04T14:30:00+11:00"),
    timeZone: SYDNEY,
  });

  const late = newForm(slotStart(date("2026-11-04"), 23 * 60 + 50), SYDNEY);
  expect(late).toMatchObject({
    startTime: "23:30",
    endDate: "2026-11-05",
    endTime: "00:30",
  });
});

test("New event starts on the next half hour", () => {
  expect(nextHalfHour(Date.parse("2026-11-05T14:10:00+11:00"), SYDNEY)).toEqual(
    { date: date("2026-11-05"), minute: 14 * 60 + 30 },
  );
  expect(nextHalfHour(Date.parse("2026-11-05T14:30:00+11:00"), SYDNEY)).toEqual(
    { date: date("2026-11-05"), minute: 15 * 60 },
  );
  expect(nextHalfHour(Date.parse("2026-11-05T23:45:00+11:00"), SYDNEY)).toEqual(
    { date: date("2026-11-06"), minute: 0 },
  );
});

test("an all-day event covers its days, and a three-day one ends after its last day", () => {
  expect(drafted(form({ allDay: true })).time).toEqual({
    kind: "allDay",
    startDate: date("2026-11-05"),
    endDate: date("2026-11-06"),
  });
  expect(drafted(form({ allDay: true, endDate: "2026-11-07" })).time).toEqual({
    kind: "allDay",
    startDate: date("2026-11-05"),
    endDate: date("2026-11-08"),
  });
  expect(
    drafted(form({ endDate: "2026-11-07", endTime: "17:00" })).time,
  ).toEqual({
    kind: "timed",
    start: Date.parse("2026-11-05T15:00:00+11:00"),
    end: Date.parse("2026-11-07T17:00:00+11:00"),
    timeZone: SYDNEY,
  });
});

test("a repeat ends after a number of times or on a day", () => {
  expect(
    drafted(
      form({ repeat: "weekly", repeatEnd: "afterTimes", repeatTimes: "6" }),
    ).repeat,
  ).toEqual({ frequency: "weekly", end: { kind: "afterTimes", times: 6 } });
  expect(
    drafted(
      form({ repeat: "daily", repeatEnd: "onDate", repeatUntil: "2026-12-24" }),
    ).repeat,
  ).toEqual({
    frequency: "daily",
    end: { kind: "onDate", date: date("2026-12-24") },
  });
  expect(drafted(form({ repeatEnd: "afterTimes" })).repeat).toBeNull();
});

test.each([
  ["no title", { title: "  " }, "title", "Add a title."],
  [
    "an end before the start",
    { endTime: "14:00" },
    "endTime",
    "The end is before the start.",
  ],
  [
    "an end day before the start",
    { endDate: "2026-11-04", endTime: "18:00" },
    "endDate",
    "The end is before the start.",
  ],
  [
    "an all-day end before the start",
    { allDay: true, endDate: "2026-11-04" },
    "endDate",
    "The end is before the start.",
  ],
  [
    "an end at the start",
    { endTime: "15:00" },
    "endTime",
    "The end is the same as the start.",
  ],
  [
    "a half-typed time",
    { startTime: "" },
    "startTime",
    "Choose when it starts.",
  ],
  [
    "a repeat with no last day",
    { repeat: "daily", repeatEnd: "onDate" },
    "repeatUntil",
    "Choose the day the repeat ends.",
  ],
  [
    "a repeat that ends before it starts",
    { repeat: "daily", repeatEnd: "onDate", repeatUntil: "2026-11-01" },
    "repeatUntil",
    "The repeat ends before the event starts.",
  ],
  [
    "every weekday from a Saturday to the Sunday",
    {
      startDate: "2026-11-07",
      endDate: "2026-11-07",
      repeat: "weekdays",
      repeatEnd: "onDate",
      repeatUntil: "2026-11-08",
    },
    "repeatUntil",
    "Every weekday skips Saturday and Sunday, so this repeat would never happen. Choose a later day for it to end.",
  ],
  [
    "a repeat of no times",
    { repeat: "daily", repeatEnd: "afterTimes", repeatTimes: "0" },
    "repeatTimes",
    "Choose a number from 1 to 999.",
  ],
  [
    "a repeat of too many times",
    { repeat: "daily", repeatEnd: "afterTimes", repeatTimes: "1000" },
    "repeatTimes",
    "Choose a number from 1 to 999.",
  ],
] as const)("%s says what to fix", (_, more, field, message) => {
  expect(draftOf(form(more), SYDNEY)).toEqual({ ok: false, field, message });
});

test("moving the start keeps the event's length", () => {
  const long = form({ endDate: "2026-11-06", endTime: "10:00" });
  expect(withStart(long, { startTime: "16:00" })).toMatchObject({
    startDate: "2026-11-05",
    startTime: "16:00",
    endDate: "2026-11-06",
    endTime: "11:00",
  });
  expect(withStart(long, { startDate: "2026-11-09" })).toMatchObject({
    endDate: "2026-11-10",
    endTime: "10:00",
  });
});

test("an event from another time zone keeps its zone, and shows on the device's clock", async () => {
  const alice = await kit.as(ALICE);
  await alice.create(
    "Alice Stone",
    {
      title: "London sync",
      location: "",
      notes: "",
      time: {
        kind: "timed",
        start: Date.parse("2026-11-05T09:00:00Z"),
        end: Date.parse("2026-11-05T10:00:00Z"),
        timeZone: LONDON,
      },
      repeat: { frequency: "weekly", end: { kind: "never" } },
      people: [],
    },
    [],
  );
  const [seen] = (
    await alice.listRange({
      from: date("2026-11-05"),
      to: date("2026-11-07"),
      timeZone: SYDNEY,
    })
  ).occurrences;
  const opened = formOf(seen!, SYDNEY);
  expect(opened).toMatchObject({
    startDate: "2026-11-05",
    startTime: "20:00",
    endTime: "21:00",
  });
  expect(drafted(opened).time).toEqual(seen!.time);
});

test("the scope question asks only for a repeat, and not about one date when the repeat changed", async () => {
  const single = await savedAndOpened(form({}));
  expect(scopesFor(single, drafted(formOf(single, SYDNEY)))).toBeNull();

  kit = await createCalendarTest();
  const series = await savedAndOpened(form({ repeat: "weekly" }));
  const opened = formOf(series, SYDNEY);
  expect(series.occurrenceId).toBe("20261105T040000Z" as OccurrenceId);
  expect(scopesFor(series, drafted({ ...opened, title: "Demo" }))).toEqual([
    "this",
    "thisAndLater",
    "all",
  ]);
  expect(scopesFor(series, drafted({ ...opened, repeat: "daily" }))).toEqual([
    "thisAndLater",
    "all",
  ]);
  expect(scopesFor(series, null)).toEqual(["this", "thisAndLater", "all"]);
});
