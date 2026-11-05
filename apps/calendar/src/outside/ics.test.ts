import { expect, test } from "bun:test";
import {
  type EmailAddress,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_EVENTS,
  type SkipReason,
  type TimeZone,
} from "../types";
import { type OutsideEvent, readCalendarFile } from "./ics";
import {
  APPLE_EXPORT,
  calendarFile,
  GOOGLE_EXPORT,
  GOOGLE_UID,
  OUTLOOK_EXPORT,
  OUTLOOK_UID,
} from "./test-support";

const LONDON = "Europe/London" as TimeZone;

function read(text: string, floating: TimeZone = LONDON) {
  const reading = readCalendarFile(text, floating);
  if (reading.status !== "read") throw new Error(reading.status);
  return reading;
}

const event = (...lines: string[]) =>
  calendarFile("BEGIN:VEVENT", ...lines, "END:VEVENT");

const titled = (events: OutsideEvent[], title: string) =>
  events.find((entry) => entry.title === title);

// Unknown, so a plain object can be compared with the branded time.
const timeOf = (events: OutsideEvent[], title: string): unknown =>
  titled(events, title)?.time;

test("a Google export keeps its weekly repeat, the date moved, the date removed, and its people", () => {
  const { events, skipped } = read(GOOGLE_EXPORT);
  expect(skipped).toEqual([]);
  expect(events).toEqual([
    {
      uid: GOOGLE_UID,
      recurrenceId: null,
      title: "Standup",
      location: "",
      notes:
        "Join with Google Meet: https://meet.google.com/abc-defg-hij\n\nLearn more about Meet at: https://support.google.com/a/users/answer/9282720",
      time: {
        kind: "timed",
        start: Date.parse("2026-11-03T09:00:00+11:00"),
        end: Date.parse("2026-11-03T09:15:00+11:00"),
        timeZone: "Australia/Sydney",
      },
      rule: "FREQ=WEEKLY;WKST=MO;BYDAY=TU",
      exdates: ["20261116T220000Z"],
      sequence: 0,
      shortfall: null,
      cancelled: false,
      organiser: { email: "alice@example.com", name: "Alice Stone" },
      attendees: [
        { email: "bo.lee@example.org", name: "Lee, Bo", answer: "accepted" },
        {
          email: "jo@example.net",
          name: "jo@example.net",
          answer: "needsAction",
        },
      ],
      conference: "https://meet.google.com/abc-defg-hij",
      stamp: Date.parse("2026-11-05T01:02:03Z"),
    },
    expect.objectContaining({
      uid: GOOGLE_UID,
      recurrenceId: "20261109T220000Z",
      title: "Standup, moved for the offsite",
      rule: null,
      sequence: 1,
      time: {
        kind: "timed",
        start: Date.parse("2026-11-10T10:00:00+11:00"),
        end: Date.parse("2026-11-10T10:15:00+11:00"),
        timeZone: "Australia/Sydney",
      },
    }),
    expect.objectContaining({
      title: "Christmas Day",
      time: { kind: "allDay", startDate: "2026-12-25", endDate: "2026-12-26" },
      rule: null,
    }),
  ]);
});

test("an Outlook export maps Windows zone names, keeps its Teams link, and ignores its alarm", () => {
  const { events, skipped } = read(OUTLOOK_EXPORT);
  expect(skipped).toEqual([]);
  expect(titled(events, "Monthly numbers")).toMatchObject({
    uid: OUTLOOK_UID,
    notes: "Quarterly numbers.",
    location: "Microsoft Teams Meeting",
    time: {
      kind: "timed",
      start: Date.parse("2026-11-12T14:00:00+11:00"),
      end: Date.parse("2026-11-12T15:00:00+11:00"),
      timeZone: "Australia/Sydney",
    },
    rule: "FREQ=MONTHLY;COUNT=6;BYDAY=2TH",
    shortfall: null,
    conference:
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0",
  });
  expect(timeOf(events, "Leadership offsite")).toEqual({
    kind: "allDay",
    startDate: "2026-12-01",
    endDate: "2026-12-04",
  });
});

test("a zone with no IANA name is read at the offset the file gives it", () => {
  expect(timeOf(read(OUTLOOK_EXPORT).events, "Darwin site visit")).toEqual({
    kind: "timed",
    start: Date.parse("2026-06-15T09:30:00+09:30"),
    end: Date.parse("2026-06-15T10:30:00+09:30"),
    timeZone: "+09:30",
  });
});

test("an Apple export keeps a trip over several days, a long weekend, and a birthday", () => {
  const { events } = read(APPLE_EXPORT);
  expect(timeOf(events, "Melbourne trip")).toEqual({
    kind: "timed",
    start: Date.parse("2026-11-06T08:00:00+11:00"),
    end: Date.parse("2026-11-09T19:00:00+11:00"),
    timeZone: "Australia/Sydney",
  });
  expect(timeOf(events, "Family at the beach")).toEqual({
    kind: "allDay",
    startDate: "2026-12-24",
    endDate: "2026-12-27",
  });
  expect(titled(events, "Sam's birthday")).toMatchObject({
    rule: "FREQ=YEARLY",
    shortfall: null,
    time: { kind: "allDay", startDate: "2027-03-01", endDate: "2027-03-02" },
  });
});

test("times with no zone, in UTC, and in a vendor's zone path each land at the right moment", () => {
  const { events } = read(
    calendarFile(
      "BEGIN:VEVENT",
      "UID:floating",
      "DTSTART:20260710T090000",
      "DURATION:PT45M",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:utc",
      "DTSTART:20260710T090000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:lightning",
      "DTSTART;TZID=/mozilla.org/20050126_1/Europe/Paris:20260710T090000",
      "DTEND;TZID=/mozilla.org/20050126_1/Europe/Paris:20260710T100000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:unknown-zone",
      "DTSTART;TZID=Somewhere Nobody Knows:20260710T090000",
      "DTEND;TZID=Somewhere Nobody Knows:20260710T100000",
      "END:VEVENT",
    ),
    "Australia/Sydney" as TimeZone,
  );
  expect(events.map((entry): unknown[] => [entry.uid, entry.time])).toEqual([
    [
      "floating",
      {
        kind: "timed",
        start: Date.parse("2026-07-10T09:00:00+10:00"),
        end: Date.parse("2026-07-10T09:45:00+10:00"),
        timeZone: "Australia/Sydney",
      },
    ],
    [
      "utc",
      {
        kind: "timed",
        start: Date.parse("2026-07-10T09:00:00Z"),
        end: Date.parse("2026-07-10T09:00:00Z") + 1,
        timeZone: "UTC",
      },
    ],
    [
      "lightning",
      {
        kind: "timed",
        start: Date.parse("2026-07-10T09:00:00+02:00"),
        end: Date.parse("2026-07-10T10:00:00+02:00"),
        timeZone: "Europe/Paris",
      },
    ],
    [
      "unknown-zone",
      {
        kind: "timed",
        start: Date.parse("2026-07-10T09:00:00+10:00"),
        end: Date.parse("2026-07-10T10:00:00+10:00"),
        timeZone: "Australia/Sydney",
      },
    ],
  ]);
});

test("text from outside loses control and direction characters and is cut to length", () => {
  const [found] = read(
    event(
      "UID:hostile-text@example.net",
      "DTSTART:20261110T090000Z",
      `SUMMARY:Pay\u0007 now\u202e gnp.exe ${"x".repeat(600)}`,
      "LOCATION:Room 1\\nRoom 2\u0000",
      "DESCRIPTION:First line\\nSecond\u0008 line",
      "ORGANIZER;CN=Mallory\u202e:mailto:mallory@evil.example<script>",
      "ATTENDEE;CN=Bo:mailto:bo@example.org",
      "ATTENDEE;CN=Nobody:javascript:alert(1)",
      "X-GOOGLE-CONFERENCE:https://meet.google.com/a\u0007b",
    ),
  ).events;
  expect(found?.title).toStartWith("Pay now gnp.exe xxx");
  expect(found?.title).toHaveLength(500);
  expect(found?.location).toBe("Room 1 Room 2");
  expect(found?.notes).toBe("First line\nSecond  line");
  expect(found?.organiser).toBeNull();
  expect(found?.attendees).toEqual([
    {
      email: "bo@example.org" as EmailAddress,
      name: "Bo",
      answer: "needsAction",
    },
  ]);
  expect(found?.conference).toBe("https://meet.google.com/a b");
});

test("a bad event is skipped and counted, and the good ones around it are kept", () => {
  const reading = read(
    calendarFile(
      ...[
        ["UID:no-start", "SUMMARY:No start"],
        ["DTSTART:20261110T090000Z", "SUMMARY:No id"],
        ["UID:feb-30", "DTSTART;VALUE=DATE:20260230"],
        ["UID:old", "DTSTART;VALUE=DATE:18000101"],
        ["UID:backwards", "DTSTART:20261110T090000Z", "DTEND:20261110T080000Z"],
        [
          "UID:never",
          "DTSTART;VALUE=DATE:20260415",
          "RRULE:FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=31",
        ],
        ["UID:bad-duration", "DTSTART:20261110T090000Z", "DURATION:soon"],
        [
          "UID:later-dates",
          "DTSTART:20261110T090000Z",
          "RECURRENCE-ID;RANGE=THISANDFUTURE:20261110T090000Z",
        ],
        [
          "UID:odd-rule",
          "DTSTART:20261110T090000Z",
          "RRULE:FREQ=YEARLY;BYMONTH=13",
        ],
        ["UID:good", "DTSTART:20261110T090000Z", "SUMMARY:Good"],
      ].flatMap((lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"]),
    ),
  );
  expect(reading.events.map((entry): string => entry.uid)).toEqual([
    "odd-rule",
    "good",
  ]);
  expect(reading.events[0]).toMatchObject({
    rule: "FREQ=YEARLY;BYMONTH=13",
    shortfall: "firstDateOnly",
  });
  expect(reading.skipped).toEqual([
    "noStart",
    "noId",
    "unreadable",
    "outOfRange",
    "endsBeforeStart",
    "neverHappens",
    "unreadable",
    "unreadable",
  ] satisfies SkipReason[]);
});

test("a rule Calendar follows, beside extra dates or rules it doesn't keep, shows only its main repeat", () => {
  const { events } = read(
    calendarFile(
      ...[
        ["UID:plain", "RRULE:FREQ=WEEKLY"],
        ["UID:rdate", "RRULE:FREQ=WEEKLY", "RDATE:20261112T090000Z"],
        ["UID:exrule", "RRULE:FREQ=WEEKLY", "EXRULE:FREQ=MONTHLY"],
        ["UID:two-rules", "RRULE:FREQ=WEEKLY", "RRULE:FREQ=DAILY;COUNT=2"],
        ["UID:odd-rdate", "RRULE:FREQ=YEARLY;BYMONTH=13", "RDATE:20261112"],
      ].flatMap((lines) => [
        "BEGIN:VEVENT",
        "DTSTART:20261110T090000Z",
        ...lines,
        "END:VEVENT",
      ]),
    ),
  );
  expect(
    events.map(({ uid, rule, shortfall }) => [uid, rule, shortfall]),
  ).toEqual([
    ["plain", "FREQ=WEEKLY", null],
    ["rdate", "FREQ=WEEKLY", "mainRepeatOnly"],
    ["exrule", "FREQ=WEEKLY", "mainRepeatOnly"],
    ["two-rules", "FREQ=WEEKLY", "mainRepeatOnly"],
    ["odd-rdate", "FREQ=YEARLY;BYMONTH=13", "firstDateOnly"],
  ]);
});

// ical.js took 16 seconds over a 4 MB line of parameters, and seconds more for each
// shape below, so each must be refused before it reaches ical.js.
const parameters = (count: number, name: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => `${name(index)}=1`).join(";");

const HOSTILE_LINES = {
  "one parameter, a million times": `ATTENDEE;${parameters(1_000_000, () => "X")}:mailto:a@example.org`,
  "distinct parameters": `ATTENDEE;${parameters(370_000, (index) => `X-${index}`)}:mailto:a@example.org`,
  "parameters on the start": `DTSTART;${parameters(1_000_000, () => "X")}:20261110T090000Z`,
  "parameters on the organiser": `ORGANIZER;${parameters(1_000_000, () => "X")}:mailto:a@example.org`,
  "a few more parameters than any app writes": `ATTENDEE;${parameters(201, () => "X")}:mailto:a@example.org`,
  "notes far longer than Calendar keeps": `DESCRIPTION:${"x".repeat(4_000_000)}`,
};

test.each(Object.entries(HOSTILE_LINES))(
  "an event with %s is skipped at once, and the events around it are kept",
  (_, line) => {
    const text = calendarFile(
      "BEGIN:VEVENT",
      "UID:before",
      "DTSTART:20261110T090000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:hostile",
      "DTSTART:20261110T090000Z",
      line,
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:after",
      "DTSTART:20261110T090000Z",
      "END:VEVENT",
    );
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      MAX_IMPORT_BYTES,
    );
    const began = performance.now();
    const { events, skipped } = read(text);
    const milliseconds = performance.now() - began;
    expect(events.map((entry): string => entry.uid)).toEqual([
      "before",
      "after",
    ]);
    expect(skipped).toEqual(["tooComplex"] satisfies SkipReason[]);
    expect(milliseconds).toBeLessThan(100);
  },
);

test("a large part Calendar doesn't read, such as an attachment in the file, is ignored", () => {
  const { events, skipped } = read(
    event(
      "UID:with-attachment",
      "DTSTART:20261110T090000Z",
      "SUMMARY:Board pack",
      `ATTACH;ENCODING=BASE64;VALUE=BINARY;FMTTYPE=application/pdf:${"A".repeat(1_000_000)}`,
      `X-ALT-DESC;FMTTYPE=text/html;${parameters(500, () => "X")}:<p>Hi</p>`,
    ),
  );
  expect(skipped).toEqual([]);
  expect(events.map((entry) => entry.title)).toEqual(["Board pack"]);
});

test("a file too big, with too many events, or not a calendar is refused whole", () => {
  const huge = event(
    "UID:big",
    "DTSTART:20261110T090000Z",
    `DESCRIPTION:${"é".repeat(MAX_IMPORT_BYTES / 2)}`,
  );
  const crowded = calendarFile(
    ...Array.from({ length: MAX_IMPORT_EVENTS + 1 }, (_, index) => [
      "BEGIN:VEVENT",
      `UID:${index}`,
      "END:VEVENT",
    ]).flat(),
  );
  const nested = calendarFile(
    ...Array.from({ length: 20 }, () => "BEGIN:VALARM"),
    ...Array.from({ length: 20 }, () => "END:VALARM"),
  );
  const status = (text: string) => readCalendarFile(text, LONDON).status;
  expect(status(huge)).toBe("tooLarge");
  expect(status(crowded)).toBe("tooManyEvents");
  expect(status(nested)).toBe("notCalendar");
  expect(status("hello")).toBe("notCalendar");
  expect(status("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\n")).toBe(
    "notCalendar",
  );
  expect(status("BEGIN:VCARD\r\nEND:VCARD\r\n")).toBe("notCalendar");
  expect(read(calendarFile())).toEqual({
    status: "read",
    method: null,
    events: [],
    skipped: [],
  });
});

test("a file says whether it invites, cancels, or answers, and anything else says nothing", () => {
  const methodOf = (...lines: string[]) => read(calendarFile(...lines)).method;
  expect(methodOf("METHOD:REQUEST")).toBe("request");
  expect(methodOf("METHOD:cancel")).toBe("cancel");
  expect(methodOf("METHOD:REPLY")).toBe("reply");
  expect(methodOf("METHOD:PUBLISH")).toBeNull();
  expect(methodOf("METHOD:COUNTER")).toBeNull();
  expect(methodOf()).toBeNull();
  // A METHOD inside an event isn't the file's.
  expect(methodOf("BEGIN:VEVENT", "METHOD:REQUEST", "END:VEVENT")).toBeNull();
  const both = (second: string) =>
    read(`${calendarFile("METHOD:REQUEST")}${second}`).method;
  expect(both(calendarFile("METHOD:REQUEST"))).toBe("request");
  expect(both(calendarFile("METHOD:CANCEL"))).toBeNull();
  // A calendar beside it that asks nothing makes the file ask nothing.
  expect(both(calendarFile())).toBeNull();
});

test("too many removed dates are refused before ical.js reads them", () => {
  const days = (count: number, from: number) =>
    Array.from({ length: count }, (_, index) =>
      new Date(Date.UTC(2027, 0, 1 + from + index))
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", ""),
    )
      .map((day) => `${day}T090000`)
      .join(",");
  const repeating = (...exdates: string[]) =>
    event(
      "UID:many@example.net",
      "DTSTART;TZID=Australia/Sydney:20261103T090000",
      "RRULE:FREQ=DAILY",
      ...exdates.map((list) => `EXDATE;TZID=Australia/Sydney:${list}`),
    );
  const began = performance.now();
  expect(read(repeating(days(1000, 0), days(1001, 1000)))).toMatchObject({
    events: [],
    skipped: ["unreadable"],
  });
  expect(performance.now() - began).toBeLessThan(500);
  expect(read(repeating(days(2000, 0))).events[0]?.exdates).toHaveLength(2000);
});
