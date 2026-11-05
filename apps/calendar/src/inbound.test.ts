import {
  afterEach,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import {
  type CalendarId,
  ensurePersonalCalendar,
  type MailboxId,
  type UserId,
} from "@cloudysuite/access";
import * as start from "@tanstack/react-start";
import * as startServer from "@tanstack/react-start/server";
import { testWorkerEnv } from "../../../src/db/test-database";
import {
  createKit,
  type Kit,
  PASSWORD,
  signIn,
} from "../../auth/src/admin/test-kit";
import { ingest, receiveInbound } from "../../mail/src/ingest";
import { createTestEnv } from "../../mail/src/test-support";
import { createFakeEmail, partOfType, readEmail } from "./email/test-support";
import {
  AUTH,
  calendarAttachment,
  DANA,
  GOOGLE_INVITE_UID,
  googleCalendar,
  googleEvent,
  googleReply,
  invitationEmail,
  MEET,
  outlookCalendar,
  outlookEvent,
  SAM,
  TEAMS,
} from "./inbound-test-support";
import { readCalendarFile } from "./outside/ics";
import { HOSTILE_RULES } from "./outside/test-support";
import { createCalendarTest, SYDNEY, TEAM } from "./test-support";
import type {
  CalendarOccurrence,
  CivilDate,
  EmailAddress,
  EventTime,
  EventUid,
  PersonToInvite,
} from "./types";
import { meetingLink } from "./ui/meeting-link";

// Every message enters through Mail's own inbound path, into real Mailbox and Calendar
// objects that share one directory. Mail's alarm hands calendar parts over, as on the
// Workers runtime.

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
const NOW = Date.parse("2026-11-05T09:00:00+11:00");
const PARTNER = "partner.example.org";
const MALLORY = "mallory@partner.example.org";

let kit: Kit;
let calendars: Awaited<ReturnType<typeof createCalendarTest>>;
let mail: ReturnType<typeof createTestEnv>;
let email: ReturnType<typeof createFakeEmail>;
let jo: UserId;
const cookies = new Map<UserId, string>();
const mailboxes = {} as Record<"boss" | "jo" | "support", MailboxId>;

function giveMailbox(
  userId: UserId,
  address: string,
  kind: "personal" | "shared",
): MailboxId {
  const mailboxId = crypto.randomUUID() as MailboxId;
  kit.sqlite.run("INSERT INTO mailboxes (id, kind, name) VALUES (?, ?, ?)", [
    mailboxId,
    kind,
    address,
  ]);
  kit.sqlite.run(
    "INSERT INTO addresses (address, domain, mailbox_id, kind) VALUES (?, 'example.com', ?, 'primary')",
    [address, mailboxId],
  );
  kit.sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'manager')",
    [mailboxId, userId],
  );
  return mailboxId;
}

beforeEach(async () => {
  setSystemTime(new Date(NOW));
  kit = await createKit();
  calendars = await createCalendarTest();
  email = createFakeEmail();
  mail = createTestEnv(kit.database);
  env.DB = kit.database;
  env.CALENDAR = calendars.env.CALENDAR;
  env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
  Object.assign(calendars.env, { DB: kit.database, EMAIL: email.binding });
  Object.assign(mail.env, { CALENDAR: calendars.env.CALENDAR });
  const { user } = await kit.auth.api.createUser({
    body: { email: "jo@example.com", password: PASSWORD, name: "Jo Okafor" },
  });
  jo = user.id as UserId;
  mailboxes.boss = giveMailbox(kit.admin, "boss@example.com", "personal");
  mailboxes.jo = giveMailbox(jo, "jo@example.com", "personal");
  mailboxes.support = giveMailbox(kit.admin, "support@example.com", "shared");
  for (const [id, address] of [
    [kit.admin, "boss@example.com"],
    [jo, "jo@example.com"],
  ] as const) {
    kit.sqlite.run("DELETE FROM rate_limit");
    cookies.set(id, (await signIn(kit, address)).headers.get("set-cookie")!);
  }
  kit.sqlite.run(
    "INSERT INTO calendars (id, kind, name, colour) VALUES (?, 'team', 'Marketing', 2)",
    [TEAM],
  );
  kit.sqlite.run(
    "INSERT INTO calendar_access (calendar_id, user_id, role) VALUES (?, ?, 'manager')",
    [TEAM, kit.admin],
  );
});

afterEach(() => {
  setSystemTime();
});

function as(userId: UserId = kit.admin) {
  request = new Request("https://calendar.example.com/_serverFn/x", {
    method: "POST",
    headers: { cookie: cookies.get(userId)! },
  });
  return functions;
}

// Runs each Mailbox alarm that is due, then each Calendar alarm, as the runtime would.
async function handOver() {
  for (const mailboxId of Object.values(mailboxes)) {
    const instance = mail.instanceOf(mailboxId);
    if (instance.alarm !== null && instance.alarm <= Date.now()) {
      instance.alarm = null;
      await instance.object.alarm();
    }
  }
  await calendars.settle();
}

// Through the Worker's email() handler, as Cloudflare delivers it, and then the alarms.
async function arrive(raw: string, to = "boss@example.com") {
  await deliver(raw, to);
  await handOver();
}

async function deliver(raw: string, to = "boss@example.com") {
  const rejections: string[] = [];
  await receiveInbound(
    {
      from: "bounces@mail.example",
      to,
      rawSize: new TextEncoder().encode(raw).byteLength,
      raw: new Response(raw).body!,
      setReject: (reason: string) => rejections.push(reason),
    } as unknown as ForwardableEmailMessage,
    mail.env,
  );
  expect(rejections).toEqual([]);
}

const google = (
  event: Parameters<typeof googleEvent>[0] = {},
  more: {
    from?: string;
    auth?: string | null;
    method?: "REQUEST" | "CANCEL";
  } = {},
) =>
  invitationEmail({
    from: more.from ?? DANA,
    auth: more.auth === undefined ? AUTH.proved(PARTNER) : more.auth,
    method: more.method ?? "REQUEST",
    calendar: googleCalendar(more.method ?? "REQUEST", googleEvent(event)),
  });

const NEXT_WEEK = {
  from: "2026-11-09" as CivilDate,
  to: "2026-11-16" as CivilDate,
  timeZone: SYDNEY,
};

async function schedule(userId: UserId = kit.admin) {
  return (await as(userId).listEvents({ data: NEXT_WEEK })).occurrences;
}

const personalOf = async (userId: UserId = kit.admin) =>
  (await as(userId).getCalendars())[0]?.id as CalendarId;

const folderOf = (mailboxId: MailboxId, folder: "inbox" | "spam" | "archive") =>
  mail
    .instanceOf(mailboxId)
    .object.listThreads({ view: { folder } })
    .threads.map((thread) => thread.subject);

const sydney = (text: string) => Date.parse(`${text}+11:00`);

// The copy's own UID in the person's calendar, which the invitation's UID and organiser
// name together.
const copyUid = async () => (await schedule())[0]!.uid;

test("an invitation from Google lands unanswered in the person's own calendar, with Join Google Meet", async () => {
  await arrive(google());

  const [event, ...rest] = await schedule();
  expect(rest).toEqual([]);
  expect(event).toMatchObject({
    title: "Supplier review",
    time: {
      kind: "timed",
      start: sydney("2026-11-10T10:00:00"),
      end: sydney("2026-11-10T11:00:00"),
      timeZone: SYDNEY,
    },
    organiser: {
      kind: "outside",
      email: DANA,
      name: "Dana Wright",
      uid: GOOGLE_INVITE_UID,
      fromOrganiser: true,
    },
    answer: "needsAnswer",
    changeable: false,
    cancelled: false,
    calendarId: await personalOf(),
  });
  expect(
    event!.people.map((person) => [person.kind, person.name, person.answer]),
  ).toEqual([["colleague", "Boss", "needsAnswer"]]);
  expect(meetingLink(event!)).toEqual({
    service: "Google Meet",
    url: MEET,
    from: "conference",
  });
  // Today's Invitations lists it, and the email stays in the Inbox as it came.
  const invitations = await as().listInvitations({
    data: { timeZone: SYDNEY },
  });
  expect(invitations.map((one) => one.title)).toEqual(["Supplier review"]);
  expect(folderOf(mailboxes.boss, "inbox")).toEqual([
    "Invitation: Supplier review",
  ]);
});

test("an invitation from Outlook lands with Join Microsoft Teams from its Teams field", async () => {
  await arrive(
    invitationEmail({
      from: SAM,
      fromName: "Sam Okafor",
      subject: "Quarterly planning",
      auth: AUTH.proved("contoso.example"),
      method: "REQUEST",
      shape: "outlook",
      calendar: outlookCalendar("REQUEST", outlookEvent()),
    }),
  );

  const [event] = await schedule();
  expect(event).toMatchObject({
    title: "Quarterly planning",
    location: "Microsoft Teams Meeting",
    time: {
      start: sydney("2026-11-11T14:00:00"),
      end: sydney("2026-11-11T15:00:00"),
    },
    organiser: { kind: "outside", email: SAM, name: "Sam Okafor" },
    answer: "needsAnswer",
  });
  expect(meetingLink(event!)).toEqual({
    service: "Microsoft Teams",
    url: TEAMS,
    from: "conference",
  });
});

test("Outlook's external meeting link counts when its Teams field is empty", () => {
  const reading = readCalendarFile(
    outlookCalendar("REQUEST", outlookEvent({ teams: "", external: TEAMS })),
    SYDNEY,
  );
  if (reading.status !== "read") throw new Error(reading.status);
  expect(reading.method).toBe("request");
  expect(reading.events[0]?.conference).toBe(TEAMS);
});

test("an update counts only from the organiser's own address, with proof", async () => {
  await arrive(google());
  const moved = {
    sequence: 1,
    title: "Supplier review, moved",
    start: "20261110T140000",
    end: "20261110T150000",
  };

  // Anyone at the same provider can prove their own address, not the organiser's.
  await arrive(google(moved, { from: MALLORY }));
  // The organiser's address, but the mail can't show it came from there.
  await arrive(google(moved, { auth: AUTH.failed(PARTNER) }));
  await arrive(google(moved, { auth: null }));
  expect(folderOf(mailboxes.boss, "spam")).toEqual([]);
  expect((await schedule()).map((one) => one.title)).toEqual([
    "Supplier review",
  ]);

  await arrive(google(moved));
  const [event] = await schedule();
  expect(event).toMatchObject({
    title: "Supplier review, moved",
    time: {
      start: sydney("2026-11-10T14:00:00"),
      end: sydney("2026-11-10T15:00:00"),
    },
    answer: "needsAnswer",
  });
});

test("a cancellation from the organiser marks it cancelled, and a forged one doesn't", async () => {
  await arrive(google());
  const cancelled = { sequence: 1, status: "CANCELLED" as const };

  await arrive(google(cancelled, { from: MALLORY, method: "CANCEL" }));
  expect((await schedule())[0]?.cancelled).toBe(false);

  await arrive(google(cancelled, { method: "CANCEL" }));
  const [event] = await schedule();
  expect(event).toMatchObject({ title: "Supplier review", cancelled: true });
  // Called off, so it isn't waiting for an answer any more.
  expect(await as().listInvitations({ data: { timeZone: SYDNEY } })).toEqual(
    [],
  );
});

test("a cancelled invitation takes no answer, and only a newer version brings it back", async () => {
  await arrive(google());
  await arrive(
    google({ sequence: 2, status: "CANCELLED" }, { method: "CANCEL" }),
  );
  // The update sent before the cancellation, arriving after it.
  await arrive(google({ sequence: 1, title: "Supplier review, moved" }));
  expect((await schedule())[0]).toMatchObject({
    title: "Supplier review",
    cancelled: true,
  });

  const refused = await as()
    .answerInvitation({
      data: {
        calendarId: await personalOf(),
        uid: await copyUid(),
        answer: "yes",
      },
    })
    .then(
      () => null,
      (thrown: unknown) => thrown,
    );
  expect((refused as Response | null)?.status).toBe(404);
  await calendars.settle();
  expect(email.attempts).toEqual([]);

  await arrive(google({ sequence: 3, title: "Supplier review, back on" }));
  expect((await schedule())[0]).toMatchObject({
    title: "Supplier review, back on",
    cancelled: false,
  });
});

test("Spam, a shared mailbox, an import, and mail while Calendar is off add nothing", async () => {
  await arrive(
    google({ uid: "spam@google.com" }, { auth: AUTH.spam(PARTNER) }),
  );
  expect(folderOf(mailboxes.boss, "spam")).toEqual([
    "Invitation: Supplier review",
  ]);

  await arrive(google({ uid: "shared@google.com" }), "support@example.com");
  expect(folderOf(mailboxes.support, "inbox")).toHaveLength(1);

  const imported = new TextEncoder().encode(
    google({ uid: "import@google.com" }),
  );
  expect(
    await ingest(mail.env, {
      source: "import",
      mailboxId: mailboxes.boss,
      raw: imported.buffer as ArrayBuffer,
    }),
  ).toMatchObject({ status: "stored" });
  await handOver();

  kit.sqlite.run(
    "INSERT INTO app_settings (app, enabled) VALUES ('calendar', 0)",
  );
  await deliver(google({ uid: "off@google.com" }));
  kit.sqlite.run("DELETE FROM app_settings");
  // What came while Calendar was off isn't handed over once it's back on.
  await handOver();

  expect(await schedule()).toEqual([]);
  expect(folderOf(mailboxes.boss, "inbox")).toHaveLength(1);
  expect(folderOf(mailboxes.boss, "archive")).toHaveLength(1);
});

test("a forged invitation that arrives first doesn't keep the real one out", async () => {
  // Someone else invited knows the UID, and sends an invitation of their own with it.
  await arrive(
    google(
      { organiser: MALLORY, title: "Moved to my place", sequence: 9 },
      { from: MALLORY },
    ),
  );
  // Or names the real organiser, which only the organiser's own mail can prove.
  await arrive(
    google(
      { title: "Called off, ignore Dana", sequence: 9 },
      { from: MALLORY },
    ),
  );
  await arrive(google());

  const shown = await schedule();
  expect(
    shown
      .map((one) => [
        one.title,
        one.organiser.kind === "outside" && one.organiser.email,
      ])
      .sort(),
  ).toEqual([
    ["Moved to my place", MALLORY],
    ["Supplier review", DANA],
  ]);
  // Answering the real one tells its organiser, under the UID they sent.
  const real = shown.find((one) => one.title === "Supplier review");
  await as().answerInvitation({
    data: { calendarId: await personalOf(), uid: real!.uid, answer: "yes" },
  });
  await calendars.settle();
  expect(email.sent.map((one) => one.to)).toEqual([DANA]);
  const reading = readCalendarFile(
    partOfType(readEmail(email.sent[0]!.raw), "text/calendar").body,
    SYDNEY,
  );
  if (reading.status !== "read") throw new Error(reading.status);
  expect(reading.events[0]?.uid).toBe(GOOGLE_INVITE_UID as EventUid);
});

test("a removed invitation stays removed when its organiser changes it", async () => {
  await arrive(google());
  await as().deleteEvent({
    data: {
      calendarId: await personalOf(),
      target: { uid: await copyUid(), occurrenceId: null },
      scope: "all",
    },
  });
  await arrive(google({ sequence: 1, title: "Supplier review, moved" }));
  expect(await schedule()).toEqual([]);
});

const TUESDAY: EventTime = {
  kind: "timed",
  start: sydney("2026-11-10T10:00:00"),
  end: sydney("2026-11-10T11:00:00"),
  timeZone: SYDNEY,
} as EventTime;

async function inviteFrom(calendarId: CalendarId, people: PersonToInvite[]) {
  const uid = await as().createEvent({
    data: {
      calendarId,
      draft: {
        title: "Weekly planning",
        location: "",
        notes: "",
        time: TUESDAY,
        repeat: null,
        people,
      },
    },
  });
  await calendars.settle();
  return uid as EventUid;
}

test("a colleague's invitation email adds nothing beside the copy their calendar sent", async () => {
  await inviteFrom(TEAM, [jo]);
  const [invitation] = email.sent.filter((one) => one.to === "jo@example.com");
  expect(invitation).toBeDefined();
  await arrive(
    [
      `Authentication-Results: ${AUTH.proved("example.com")}`,
      invitation!.raw,
    ].join("\r\n"),
    "jo@example.com",
  );
  expect(folderOf(mailboxes.jo, "inbox")).toHaveLength(1);
  expect((await schedule(jo)).map((one) => one.title)).toEqual([
    "Weekly planning",
  ]);
});

const peopleOf = (event: CalendarOccurrence | undefined) =>
  event?.people.map((person) => [person.name, person.answer]);

test("a reply from someone outside sets only their answer, and only from their own address", async () => {
  const personal = await ensurePersonalCalendar(kit.database, kit.admin);
  const uid = await inviteFrom(personal, [jo, { email: DANA as EmailAddress }]);
  const reply = (from: string, auth: string, partstat = "ACCEPTED") =>
    invitationEmail({
      from,
      auth,
      method: "REPLY",
      subject: "Accepted: Weekly planning",
      calendar: googleReply(uid, DANA, partstat),
    });

  await arrive(reply(MALLORY, AUTH.proved(PARTNER)));
  await arrive(reply(DANA, AUTH.failed(PARTNER)));
  await arrive(reply(DANA, AUTH.spam(PARTNER)));
  expect(peopleOf((await schedule())[0])).toEqual([
    ["Jo Okafor", "needsAnswer"],
    [DANA, "needsAnswer"],
  ]);

  await arrive(reply(DANA, AUTH.proved(PARTNER)));
  expect(peopleOf((await schedule())[0])).toEqual([
    ["Jo Okafor", "needsAnswer"],
    ["Dana Wright", "yes"],
  ]);
  // Jo's copy hears it too.
  expect(peopleOf((await schedule(jo))[0])).toEqual([
    ["Jo Okafor", "needsAnswer"],
    ["Dana Wright", "yes"],
  ]);
});

test("a reply to an event on a team calendar finds it there", async () => {
  const uid = await inviteFrom(TEAM, [{ email: DANA as EmailAddress }]);
  await arrive(
    invitationEmail({
      from: DANA,
      auth: AUTH.proved(PARTNER),
      method: "REPLY",
      calendar: googleReply(uid, DANA, "DECLINED"),
    }),
  );
  const [event] = await schedule();
  expect(event?.calendarId).toBe(TEAM);
  expect(peopleOf(event)).toEqual([["Dana Wright", "no"]]);
});

test("an earlier answer that arrives late doesn't replace a later one", async () => {
  const uid = await inviteFrom(TEAM, [{ email: DANA as EmailAddress }]);
  const reply = (partstat: string, stamp: string) =>
    invitationEmail({
      from: DANA,
      auth: AUTH.proved(PARTNER),
      method: "REPLY",
      calendar: googleReply(
        uid,
        DANA,
        partstat,
        "Dana Wright",
        "boss@example.com",
        stamp,
      ),
    });
  await arrive(reply("DECLINED", "20261105T030000Z"));
  await arrive(reply("ACCEPTED", "20261105T020000Z"));
  expect(peopleOf((await schedule())[0])).toEqual([["Dana Wright", "no"]]);
  await arrive(reply("TENTATIVE", "20261105T040000Z"));
  expect(peopleOf((await schedule())[0])).toEqual([["Dana Wright", "maybe"]]);
});

test("the person shows by their own name, whatever the invitation calls them, and their reply goes under it", async () => {
  await arrive(
    google({
      guests: [
        [DANA, "ACCEPTED", "Dana Wright"],
        ["boss@example.com", "NEEDS-ACTION", "Gullible Intern"],
      ],
    }),
  );
  const [event] = await schedule();
  expect(peopleOf(event)).toEqual([["Boss", "needsAnswer"]]);

  await as().answerInvitation({
    data: { calendarId: await personalOf(), uid: event!.uid, answer: "yes" },
  });
  await calendars.settle();
  const read = readEmail(email.sent[0]!.raw);
  expect(read.headers.get("from")).toBe('"Boss" <boss@example.com>');
  const reading = readCalendarFile(
    partOfType(read, "text/calendar").body,
    SYDNEY,
  );
  if (reading.status !== "read") throw new Error(reading.status);
  expect(reading.events[0]?.attendees).toEqual([
    {
      email: "boss@example.com" as EmailAddress,
      name: "Boss",
      answer: "accepted",
    },
  ]);
});

test("answering an invitation from outside emails one reply, from the person's own address", async () => {
  await arrive(google());
  const calendarId = await personalOf();
  await as().answerInvitation({
    data: { calendarId, uid: await copyUid(), answer: "yes" },
  });
  await calendars.settle();

  expect(email.sent.map((one) => [one.from, one.to])).toEqual([
    ["boss@example.com", DANA],
  ]);
  const read = readEmail(email.sent[0]!.raw);
  expect(read.headers.get("from")).toBe('"Boss" <boss@example.com>');
  expect(read.headers.get("to")).toBe(`"Dana Wright" <${DANA}>`);
  expect(read.subject).toStartWith("Accepted: Supplier review, Tue 10 Nov");
  const calendar = partOfType(read, "text/calendar");
  expect(calendar.headers.get("content-type")).toBe(
    "text/calendar; charset=UTF-8; method=REPLY",
  );
  const reading = readCalendarFile(calendar.body, SYDNEY);
  if (reading.status !== "read") throw new Error(reading.status);
  expect(reading.method).toBe("reply");
  expect(reading.events).toMatchObject([
    {
      uid: GOOGLE_INVITE_UID,
      sequence: 0,
      organiser: { email: DANA },
      attendees: [{ email: "boss@example.com", answer: "accepted" }],
    },
  ]);
  expect((await schedule())[0]?.answer).toBe("yes");
  expect(await as().listInvitations({ data: { timeZone: SYDNEY } })).toEqual(
    [],
  );
});

test("with Mail off, an answer is saved, the organiser isn't told, and the buttons say so first", async () => {
  await arrive(google());
  kit.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
  expect(await as().getOutsideInviting({ data: { event: null } })).toBe(
    "mailOff",
  );
  await as().answerInvitation({
    data: {
      calendarId: await personalOf(),
      uid: await copyUid(),
      answer: "no",
    },
  });
  await calendars.settle();
  expect(email.attempts).toEqual([]);
  expect((await schedule())[0]?.answer).toBe("no");
});

test("an invitation that arrives again changes nothing, not even the answer given", async () => {
  const raw = google();
  await arrive(raw);
  await arrive(raw);
  expect(folderOf(mailboxes.boss, "inbox")).toHaveLength(1);
  await as().answerInvitation({
    data: {
      calendarId: await personalOf(),
      uid: await copyUid(),
      answer: "maybe",
    },
  });
  // The same invitation in a new email, as Google sends when asked again.
  await arrive(google());

  expect(folderOf(mailboxes.boss, "inbox")).toHaveLength(2);
  const shown = await schedule();
  expect(shown.map((one) => [one.title, one.answer])).toEqual([
    ["Supplier review", "maybe"],
  ]);
});

test("an invitation moved to Spam before it's handed over adds nothing", async () => {
  await deliver(google());
  const box = mail.instanceOf(mailboxes.boss).object;
  const [thread] = box.listThreads({ view: { folder: "inbox" } }).threads;
  box.moveToFolder({ threadIds: [thread!.id] }, "spam");
  await handOver();

  expect(await schedule()).toEqual([]);
  expect(folderOf(mailboxes.boss, "spam")).toEqual([
    "Invitation: Supplier review",
  ]);
});

test("the mail is kept when its notification or its hand-off to Calendar can't be queued", async () => {
  const box = mail.instanceOf(mailboxes.boss);
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    box.sqlite.run("DROP TABLE push_outbox");
    await deliver(
      [
        "From: Pat <pat@friend.example.net>",
        "To: boss@example.com",
        "Subject: Lunch on Friday",
        "Message-ID: <lunch@friend.example.net>",
        "Date: Thu, 05 Nov 2026 00:00:00 +0000",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Are you free?",
      ].join("\r\n"),
    ).catch(() => {});
    box.sqlite.run("DROP TABLE calendar_handoffs");
    await deliver(google()).catch(() => {});
  } finally {
    logged.mockRestore();
  }
  expect(folderOf(mailboxes.boss, "inbox").sort()).toEqual([
    "Invitation: Supplier review",
    "Lunch on Friday",
  ]);
});

test("the mail is kept when Calendar can't be reached, and the invitation lands on a later try", async () => {
  const personal = await ensurePersonalCalendar(kit.database, kit.admin);
  calendars.unreachable.add(personal);
  await arrive(google());
  expect(folderOf(mailboxes.boss, "inbox")).toEqual([
    "Invitation: Supplier review",
  ]);
  expect(await schedule()).toEqual([]);

  calendars.unreachable.delete(personal);
  const retry = mail.instanceOf(mailboxes.boss).alarm;
  expect(retry).toBeGreaterThan(Date.now());
  setSystemTime(new Date(retry!));
  await handOver();
  setSystemTime(new Date(NOW));
  expect((await schedule()).map((one) => one.title)).toEqual([
    "Supplier review",
  ]);
});

test("an invitation to more than a hundred people arrives, with all of them on People", async () => {
  const guests = Array.from(
    { length: 120 },
    (_, index) =>
      [`guest${index}@big.example.org`, "NEEDS-ACTION"] as [string, string],
  );
  await arrive(
    google({
      guests: [
        [DANA, "ACCEPTED", "Dana Wright"],
        ["boss@example.com", "NEEDS-ACTION"],
        ...guests,
      ],
    }),
  );
  const [event] = await schedule();
  expect(event?.title).toBe("Supplier review");
  expect(event?.people).toHaveLength(121);
});

test("an invitation Calendar never takes is given up after its last try, and the log says why", async () => {
  const personal = await ensurePersonalCalendar(kit.database, kit.admin);
  calendars.unreachable.add(personal);
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    await arrive(google());
    for (let retry = 0; retry < 40; retry++) {
      const at = mail.instanceOf(mailboxes.boss).alarm;
      if (at === null) break;
      setSystemTime(new Date(at));
      await handOver();
    }
    const gaveUp = logged.mock.calls.filter(([message]) =>
      String(message).includes("Gave up"),
    );
    expect(gaveUp).toHaveLength(1);
    expect(String(gaveUp[0]?.[1])).toContain("Calendar unreachable");
  } finally {
    logged.mockRestore();
    setSystemTime(new Date(NOW));
  }
  expect(mail.instanceOf(mailboxes.boss).alarm).toBeNull();
  expect(folderOf(mailboxes.boss, "inbox")).toEqual([
    "Invitation: Supplier review",
  ]);
});

// D1 refuses a Worker invocation more than 50 queries on the free plan, and counts a
// batch as one.
const D1_QUERIES_PER_INVOCATION = 50;

function countQueries() {
  type Statement = {
    bind: (...params: unknown[]) => Statement;
    all: () => unknown;
    raw: () => unknown;
    run: () => unknown;
  };
  const database = kit.database as unknown as {
    prepare: (sql: string) => Statement;
    batch: (statements: Statement[]) => unknown;
  };
  const { prepare, batch } = database;
  const counter = { count: 0 };
  const counted = (statement: Statement): Statement => ({
    ...statement,
    bind: (...params) => counted(statement.bind(...params)),
    all: () => (counter.count++, statement.all()),
    raw: () => (counter.count++, statement.raw()),
    run: () => (counter.count++, statement.run()),
  });
  database.prepare = (sql) => counted(prepare(sql));
  database.batch = (statements) => (counter.count++, batch(statements));
  return {
    counter,
    stop: () => Object.assign(database, { prepare, batch }),
  };
}

// One run of the mailbox's alarm, with the directory queries it made.
async function mailAlarmRun() {
  const instance = mail.instanceOf(mailboxes.boss);
  instance.alarm = null;
  const queries = countQueries();
  try {
    await instance.object.alarm();
  } finally {
    queries.stop();
  }
  await calendars.settle();
  return queries.counter.count;
}

const manyInvitations = (prefix: string) =>
  googleCalendar(
    "REQUEST",
    ...Array.from({ length: 200 }, (_, index) =>
      googleEvent({
        uid: `${prefix}-${index}@evil.example`,
        title: `Event ${prefix} ${index}`,
      }),
    ),
  );

test("an email with hundreds of events adds only its first 20, within D1's query limit", async () => {
  await deliver(
    invitationEmail({
      from: SAM,
      auth: AUTH.proved("contoso.example"),
      method: "REQUEST",
      shape: "outlook",
      calendar: manyInvitations("a"),
      parts: [
        calendarAttachment(manyInvitations("b"), "b.ics"),
        calendarAttachment(manyInvitations("c"), "c.ics"),
      ],
    }),
  );
  expect(await mailAlarmRun()).toBeLessThan(D1_QUERIES_PER_INVOCATION);
  expect((await schedule()).map((one) => one.title).sort()).toEqual(
    Array.from({ length: 20 }, (_, index) => `Event a ${index}`).sort(),
  );
});

test("a burst of invitation emails reaches the calendar a few at a time, and all of it soon after", async () => {
  for (let index = 0; index < 10; index++) {
    await deliver(
      google({ uid: `burst-${index}@google.com`, title: `Burst ${index}` }),
    );
  }
  await mailAlarmRun();
  expect((await schedule()).length).toBeLessThanOrEqual(3);
  expect(mail.instanceOf(mailboxes.boss).alarm).toBeLessThanOrEqual(Date.now());

  for (let run = 0; run < 10; run++) {
    expect(await mailAlarmRun()).toBeLessThan(D1_QUERIES_PER_INVOCATION);
  }
  expect(await schedule()).toHaveLength(10);
});

test("a reply email answers only its first 20 events, within D1's query limit", async () => {
  const uid = await inviteFrom(TEAM, [{ email: DANA as EmailAddress }]);
  const answering = (uids: string[]) =>
    invitationEmail({
      from: DANA,
      auth: AUTH.proved(PARTNER),
      method: "REPLY",
      calendar: googleCalendar(
        "REPLY",
        ...uids.map((one) => {
          const text = googleReply(one, DANA, "ACCEPTED");
          return text
            .slice(text.indexOf("BEGIN:VEVENT"), text.indexOf("END:VCALENDAR"))
            .trimEnd()
            .split("\r\n");
        }),
      ),
    });
  const others = Array.from(
    { length: 199 },
    (_, index) => `elsewhere-${index}@google.com`,
  );

  await deliver(answering([...others.slice(0, 20), uid]));
  await mailAlarmRun();
  expect(peopleOf((await schedule())[0])).toEqual([[DANA, "needsAnswer"]]);

  await deliver(answering([uid, ...others]));
  expect(await mailAlarmRun()).toBeLessThan(D1_QUERIES_PER_INVOCATION);
  expect(peopleOf((await schedule())[0])).toEqual([["Dana Wright", "yes"]]);
});

test("a calendar part too large to read adds nothing, and the mail is still kept", async () => {
  const filler = Array.from(
    { length: 300 },
    (_, index) => `X-FILLER-${index}:${"x".repeat(1000)}`,
  );
  const began = performance.now();
  await arrive(google({ extra: filler }));
  expect(performance.now() - began).toBeLessThan(2000);
  expect(folderOf(mailboxes.boss, "inbox")).toHaveLength(1);
  expect(await schedule()).toEqual([]);
});

test("only the first few calendar parts of one email are read", async () => {
  const another = (uid: string, title: string) =>
    calendarAttachment(
      googleCalendar("REQUEST", googleEvent({ uid, title })),
      `${uid}.ics`,
    );
  await arrive(
    invitationEmail({
      from: SAM,
      auth: AUTH.proved("contoso.example"),
      method: "REQUEST",
      shape: "outlook",
      calendar: outlookCalendar("REQUEST", outlookEvent()),
      parts: [
        another("second@google.com", "Second"),
        another("third@google.com", "Third"),
        another("fourth@google.com", "Fourth"),
      ],
    }),
  );
  expect((await schedule()).map((one) => one.title).sort()).toEqual([
    "Quarterly planning",
    "Second",
    "Third",
  ]);
});

test("a repeat rule that would stall the reader shows only its first date, promptly", async () => {
  const began = performance.now();
  await arrive(google({ rule: HOSTILE_RULES[0] }));
  const shown = await schedule();
  expect(performance.now() - began).toBeLessThan(2000);
  expect(shown.map((one) => [one.title, one.repeat])).toEqual([
    ["Supplier review", { frequency: "custom" }],
  ]);
});

test("a line break in an invitation can't add a line to the reply", async () => {
  await arrive(
    google({ title: "Plan\\nBcc: evil@evil.example\rX-INJECTED:1" }),
  );
  const [event] = await schedule();
  expect(event?.title).toBe("Plan Bcc: evil@evil.example");
  await as().answerInvitation({
    data: {
      calendarId: await personalOf(),
      uid: await copyUid(),
      answer: "yes",
    },
  });
  await calendars.settle();
  const read = readEmail(email.sent[0]!.raw);
  expect([...read.headers.keys()]).not.toContain("bcc");
  expect(read.subject).toStartWith("Accepted: Plan Bcc: evil@evil.example, ");
  const ics = partOfType(read, "text/calendar").body;
  expect(ics).not.toContain("X-INJECTED");
  expect(
    ics.split("\r\n").filter((line) => line.startsWith("ATTENDEE")),
  ).toHaveLength(1);
});
