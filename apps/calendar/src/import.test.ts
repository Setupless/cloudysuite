import { beforeEach, expect, test } from "bun:test";
import { readCalendarFile } from "./outside/ics";
import {
  APPLE_EXPORT,
  calendarFile,
  GOOGLE_EXPORT,
  GOOGLE_UID,
  OUTLOOK_EXPORT,
} from "./outside/test-support";
import { parseEventSearch } from "./search-query";
import { groupForImport } from "./store";
import {
  ALICE,
  BOB,
  createCalendarTest,
  date,
  draft,
  LONDON,
  SYDNEY,
} from "./test-support";
import type {
  EmailAddress,
  EventUid,
  Occurrence,
  Repeat,
  TimeZone,
} from "./types";
import { meetingLink } from "./ui/meeting-link";

let kit: Awaited<ReturnType<typeof createCalendarTest>>;

beforeEach(async () => {
  kit = await createCalendarTest();
  kit.join(BOB, "viewer");
});

function groupsOf(text: string) {
  const reading = readCalendarFile(text, SYDNEY);
  if (reading.status !== "read") throw new Error(reading.status);
  return groupForImport(reading.events);
}

async function importFile(text: string, userId = ALICE) {
  const name = userId === ALICE ? "Alice Stone" : "Bob Lee";
  return (await kit.as(userId)).importEvents(name, groupsOf(text));
}

async function shown(from: string, to: string, timeZone: TimeZone = SYDNEY) {
  const listing = await (
    await kit.as(ALICE)
  ).listRange({ from: date(from), to: date(to), timeZone });
  return listing.occurrences.map((occurrence: Occurrence) => [
    occurrence.title,
    occurrence.time.kind === "allDay"
      ? occurrence.time.startDate
      : new Intl.DateTimeFormat("sv-SE", {
          timeZone,
          dateStyle: "short",
          timeStyle: "short",
        }).format(occurrence.time.start),
  ]);
}

const rows = () =>
  kit
    .sqlite()
    .query(
      "SELECT uid, recurrence_id, title, starts_at, start_date, rrule, exdates, organiser, sequence FROM events ORDER BY uid, recurrence_id",
    )
    .all();

const standup = (sequence: number, title: string) =>
  calendarFile(
    "BEGIN:VEVENT",
    `UID:${GOOGLE_UID}`,
    "DTSTART;TZID=Australia/Sydney:20261103T090000",
    "DTEND;TZID=Australia/Sydney:20261103T091500",
    "RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=TU",
    `SEQUENCE:${sequence}`,
    `SUMMARY:${title}`,
    "END:VEVENT",
  );

test("a Google export shows its repeat, with the moved date moved and the removed date gone", async () => {
  expect(await importFile(GOOGLE_EXPORT)).toEqual({
    status: "done",
    summary: {
      added: 2,
      updated: 0,
      unchanged: 0,
      organisedElsewhere: 0,
      firstDateOnly: 0,
      mainRepeatOnly: 0,
      skipped: {},
    },
  });
  expect(await shown("2026-11-01", "2026-12-01")).toEqual([
    ["Standup", "2026-11-03 09:00"],
    ["Standup, moved for the offsite", "2026-11-10 10:00"],
    ["Standup", "2026-11-24 09:00"],
  ]);
  const listing = await (
    await kit.as(ALICE)
  ).listRange({
    from: date("2026-11-03"),
    to: date("2026-11-04"),
    timeZone: SYDNEY,
  });
  expect(listing.occurrences[0]?.organiser).toEqual({
    kind: "madeHere",
    userId: ALICE,
    name: "Alice Stone",
  });
});

test("an all-day event is on the same day everywhere, and a long one covers every day", async () => {
  await importFile(GOOGLE_EXPORT);
  await importFile(APPLE_EXPORT);
  for (const zone of [SYDNEY, LONDON, "America/Los_Angeles" as TimeZone]) {
    expect(await shown("2026-12-25", "2026-12-26", zone)).toEqual([
      ["Family at the beach", "2026-12-24"],
      ["Christmas Day", "2026-12-25"],
    ]);
  }
  expect(await shown("2026-11-08", "2026-11-09")).toEqual([
    ["Melbourne trip", "2026-11-06 08:00"],
  ]);
});

test("an Outlook event in a Windows zone and one in a zone with no name both land at the right time", async () => {
  await importFile(OUTLOOK_EXPORT);
  expect(await shown("2026-11-12", "2026-11-13")).toEqual([
    ["Monthly numbers", "2026-11-12 14:00"],
  ]);
  expect(await shown("2027-04-08", "2027-04-09")).toEqual([
    ["Monthly numbers", "2027-04-08 14:00"],
  ]);
  expect(
    await shown("2026-06-15", "2026-06-16", "Australia/Darwin" as TimeZone),
  ).toEqual([["Darwin site visit", "2026-06-15 09:30"]]);
});

test("an imported event keeps the meeting link from its conference field", async () => {
  await importFile(OUTLOOK_EXPORT);
  const listing = await (
    await kit.as(ALICE)
  ).listRange({
    from: date("2026-11-12"),
    to: date("2026-11-13"),
    timeZone: SYDNEY,
  });
  expect(meetingLink(listing.occurrences[0]!)).toEqual({
    service: "Microsoft Teams",
    url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0",
    from: "conference",
  });
});

test("importing the same file again changes nothing", async () => {
  await importFile(GOOGLE_EXPORT);
  const before = rows();
  expect(await importFile(GOOGLE_EXPORT)).toEqual({
    status: "done",
    summary: {
      added: 0,
      updated: 0,
      unchanged: 2,
      organisedElsewhere: 0,
      firstDateOnly: 0,
      mainRepeatOnly: 0,
      skipped: {},
    },
  });
  expect(rows()).toEqual(before);
});

test("an older file can't undo a newer one, and a newer one updates", async () => {
  await importFile(standup(2, "Standup, second version"));
  expect(await importFile(standup(1, "Standup, first version"))).toMatchObject({
    summary: { unchanged: 1 },
  });
  expect(await shown("2026-11-03", "2026-11-04")).toEqual([
    ["Standup, second version", "2026-11-03 09:00"],
  ]);
  expect(await importFile(standup(3, "Standup, third version"))).toMatchObject({
    summary: { updated: 1 },
  });
  expect(await shown("2026-11-03", "2026-11-04")).toEqual([
    ["Standup, third version", "2026-11-03 09:00"],
  ]);
});

test("a removed event stays removed, even when a newer file has it", async () => {
  await importFile(GOOGLE_EXPORT);
  const alice = await kit.as(ALICE);
  await alice.remove({ uid: GOOGLE_UID as never, occurrenceId: null }, "all");
  expect(await importFile(standup(9, "Standup, back again"))).toMatchObject({
    summary: { unchanged: 1, added: 0 },
  });
  expect(await shown("2026-11-01", "2026-12-01")).toEqual([]);
});

test("a date removed here stays removed when the file comes again", async () => {
  await importFile(GOOGLE_EXPORT);
  const alice = await kit.as(ALICE);
  await alice.remove(
    { uid: GOOGLE_UID as never, occurrenceId: "20261123T220000Z" as never },
    "this",
  );
  await importFile(GOOGLE_EXPORT);
  expect(await shown("2026-11-24", "2026-11-25")).toEqual([]);

  await alice.remove(
    { uid: GOOGLE_UID as never, occurrenceId: "20261109T220000Z" as never },
    "this",
  );
  const newerChange = calendarFile(
    "BEGIN:VEVENT",
    `UID:${GOOGLE_UID}`,
    "RECURRENCE-ID;TZID=Australia/Sydney:20261110T090000",
    "DTSTART;TZID=Australia/Sydney:20261110T110000",
    "SEQUENCE:9",
    "SUMMARY:Standup, moved again",
    "END:VEVENT",
  );
  expect(await importFile(newerChange)).toMatchObject({
    summary: { unchanged: 1 },
  });
  expect(await shown("2026-11-10", "2026-11-11")).toEqual([]);
});

test("an invitation organised somewhere else stays as it is", async () => {
  kit.arrive({
    uid: GOOGLE_UID,
    title: "Standup, as invited",
    start: Date.parse("2026-11-03T09:00:00+11:00"),
    end: Date.parse("2026-11-03T09:15:00+11:00"),
    timeZone: SYDNEY,
    rule: null,
    organiser: {
      kind: "outside",
      email: "jo@example.net" as EmailAddress,
      name: "Jo",
      uid: GOOGLE_UID as EventUid,
      fromOrganiser: true,
    },
  });
  const before = rows();
  expect(await importFile(standup(5, "Standup, taken over"))).toMatchObject({
    summary: { unchanged: 0, organisedElsewhere: 1 },
  });
  expect(rows()).toEqual(before);
});

test("a repeat with an extra date shows its main repeat and is counted as such", async () => {
  const withExtraDate = calendarFile(
    "BEGIN:VEVENT",
    "UID:extra-date@example.net",
    "DTSTART;TZID=Australia/Sydney:20261103T090000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "RDATE;TZID=Australia/Sydney:20261105T090000",
    "SUMMARY:Planning",
    "END:VEVENT",
  );
  expect(await importFile(withExtraDate)).toMatchObject({
    summary: { added: 1, firstDateOnly: 0, mainRepeatOnly: 1 },
  });
  expect(await shown("2026-11-01", "2026-12-01")).toEqual([
    ["Planning", "2026-11-03 09:00"],
    ["Planning", "2026-11-10 09:00"],
    ["Planning", "2026-11-17 09:00"],
  ]);
});

test("renaming an imported fortnightly repeat keeps its dates as the file wrote them", async () => {
  await importFile(
    calendarFile(
      "BEGIN:VEVENT",
      "UID:pay-run@example.net",
      "DTSTART;TZID=Australia/Sydney:20261103T080000",
      "DTEND;TZID=Australia/Sydney:20261103T083000",
      // Ends at 07:00 on 15 December, before that day's 08:00 date.
      "RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU;UNTIL=20261214T200000Z",
      "EXDATE;TZID=Australia/Sydney:20261117T080000",
      "SUMMARY:Pay run",
      "END:VEVENT",
    ),
  );
  const dates = ["2026-11-03 08:00", "2026-12-01 08:00"];
  expect(await shown("2026-11-01", "2027-01-01")).toEqual(
    dates.map((when) => ["Pay run", when]),
  );
  const listing = await (
    await kit.as(ALICE)
  ).listRange({
    from: date("2026-11-01"),
    to: date("2026-11-04"),
    timeZone: SYDNEY,
  });
  const [first] = listing.occurrences;
  expect(first?.repeat?.frequency).toBe("fortnightly");

  expect(
    await (
      await kit.as(ALICE)
    ).update(
      { uid: first!.uid, occurrenceId: null },
      "all",
      draft(first!.time, { title: "Pay day", repeat: first!.repeat as Repeat }),
      [],
    ),
  ).toEqual({ status: "done" });
  expect(await shown("2026-11-01", "2027-01-01")).toEqual(
    dates.map((when) => ["Pay day", when]),
  );
});

test("a retry after a crash part way through ends the same as one import", async () => {
  const groups = groupsOf(GOOGLE_EXPORT + APPLE_EXPORT);
  await (await kit.as(ALICE)).importEvents("Alice Stone", groups.slice(0, 2));
  await (await kit.as(ALICE)).importEvents("Alice Stone", groups);
  const retried = rows();

  kit = await createCalendarTest();
  await (await kit.as(ALICE)).importEvents("Alice Stone", groups);
  expect(rows()).toEqual(retried);
});

test("someone with Can view can't import, and nothing is written", async () => {
  expect(await importFile(GOOGLE_EXPORT, BOB)).toEqual({ status: "noAccess" });
  expect(rows()).toEqual([]);
});

test("a change to one date of a repeat that isn't here is skipped", async () => {
  const onlyTheChange = calendarFile(
    "BEGIN:VEVENT",
    "UID:elsewhere@example.net",
    "RECURRENCE-ID:20261110T220000Z",
    "DTSTART:20261110T230000Z",
    "SUMMARY:Moved",
    "END:VEVENT",
  );
  expect(await importFile(onlyTheChange)).toMatchObject({
    summary: { added: 0, skipped: { noSeries: 1 } },
  });
});

test("a newer file can cancel one date, and can't cancel a whole event", async () => {
  await importFile(GOOGLE_EXPORT);
  const cancelled = calendarFile(
    "BEGIN:VEVENT",
    `UID:${GOOGLE_UID}`,
    "RECURRENCE-ID;TZID=Australia/Sydney:20261124T090000",
    "DTSTART;TZID=Australia/Sydney:20261124T090000",
    "SEQUENCE:2",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:20261225_holiday@google.com",
    "DTSTART;VALUE=DATE:20261225",
    "SEQUENCE:4",
    "STATUS:CANCELLED",
    "END:VEVENT",
  );
  expect(await importFile(cancelled)).toMatchObject({
    summary: { updated: 1, unchanged: 1 },
  });
  expect(await shown("2026-11-24", "2026-11-25")).toEqual([]);
  expect(await shown("2026-12-25", "2026-12-26")).toEqual([
    ["Christmas Day", "2026-12-25"],
  ]);
});

async function found(text: string) {
  const parsed = parseEventSearch(text);
  if (!parsed.ok) throw new Error(parsed.problem);
  const { occurrences } = await (
    await kit.as(ALICE)
  ).search(parsed.terms, SYDNEY);
  return [...new Set(occurrences.map((occurrence) => occurrence.title))];
}

test("an imported event is found by search, by its new title once a newer file renames it", async () => {
  await importFile(OUTLOOK_EXPORT);
  expect(await found("monthly")).toEqual(["Monthly numbers"]);
  expect(await found("teams")).toEqual(["Monthly numbers"]);
  expect(await found("quarterly")).toEqual(["Monthly numbers"]);

  await importFile(standup(1, "Standup kickoff"));
  await importFile(standup(2, "Standup retro"));
  expect(await found("kickoff")).toEqual([]);
  expect(await found("retro")).toEqual(["Standup retro"]);
});
