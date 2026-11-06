import {
  afterEach,
  beforeEach,
  expect,
  mock,
  setSystemTime,
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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testWorkerEnv } from "../../../src/db/test-database";
import {
  createKit,
  type Kit,
  PASSWORD,
  signIn,
} from "../../auth/src/admin/test-kit";
import {
  createFakeEmail,
  partOfType,
  readEmail,
} from "../../calendar/src/email/test-support";
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
} from "../../calendar/src/inbound-test-support";
import { readCalendarFile } from "../../calendar/src/outside/ics";
import {
  createCalendarTest,
  SYDNEY,
  TEAM,
} from "../../calendar/src/test-support";
import type {
  CivilDate,
  EmailAddress,
  EventTime,
  EventUid,
  PersonToInvite,
  TimeZone,
} from "../../calendar/src/types";
import { MailInvitationCard } from "../../calendar/src/ui/mail-card";
import { ingest, receiveInbound } from "./ingest";
import { createTestEnv } from "./test-support";
import type { MessageId } from "./types";

// Each message enters through Mail's inbound path into real Mailbox and Calendar objects
// that share one directory, and the card is read through Mail's own server functions.

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
const card = await import("./invitation-functions");
const calendarFunctions = await import("../../calendar/src/functions");

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
  Object.assign(env, {
    DB: kit.database,
    CALENDAR: calendars.env.CALENDAR,
    MAILBOX: mail.env.MAILBOX,
    BUCKET: mail.env.BUCKET,
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  });
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

function signedIn(userId: UserId, host: string) {
  request = new Request(`https://${host}/_serverFn/x`, {
    method: "POST",
    headers: { cookie: cookies.get(userId)! },
  });
}

// Mail's functions, as the reading pane calls them.
function inMail(userId: UserId = kit.admin) {
  signedIn(userId, "mail.example.com");
  return card;
}

// Calendar's own functions, as its pages call them.
function inCalendar(userId: UserId = kit.admin) {
  signedIn(userId, "calendar.example.com");
  return calendarFunctions;
}

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

const latestIn = (mailboxId: MailboxId) =>
  (
    mail
      .instanceOf(mailboxId)
      .sqlite.query("SELECT max(id) AS id FROM messages")
      .get() as { id: number }
  ).id as MessageId;

// Through the Worker's email() handler and the alarms. The new message's id.
async function arrive(raw: string, to = "boss@example.com") {
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
  await handOver();
  const name = to.slice(0, to.indexOf("@")) as keyof typeof mailboxes;
  return latestIn(mailboxes[name]);
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

const readCard = (
  messageId: MessageId,
  mailboxId = mailboxes.boss,
  userId = kit.admin,
) => inMail(userId).getInvitationCard({ data: { mailboxId, messageId } });

const target = (messageId: MessageId, mailboxId = mailboxes.boss) => ({
  data: { mailboxId, messageId },
});

const NEXT_WEEK = {
  from: "2026-11-09" as CivilDate,
  to: "2026-11-16" as CivilDate,
  timeZone: SYDNEY,
};

const schedule = async (userId: UserId = kit.admin) =>
  (await inCalendar(userId).listEvents({ data: NEXT_WEEK })).occurrences;

const personalOf = async (userId: UserId = kit.admin) =>
  (await inCalendar(userId).getCalendars())[0]?.id as CalendarId;

const sydney = (text: string) => Date.parse(`${text}+11:00`);

const TUESDAY_TEN: EventTime = {
  kind: "timed",
  start: sydney("2026-11-10T10:00:00"),
  end: sydney("2026-11-10T11:00:00"),
  timeZone: SYDNEY as TimeZone,
};

async function refusalOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    return {
      status: thrown.status,
      message: ((await thrown.json()) as { message: string }).message,
    };
  }
  throw new Error("expected a refusal");
}

test("an invitation from Google shows what, when, where, and who, with Join Google Meet and the answer buttons", async () => {
  const messageId = await arrive(google());

  expect(await readCard(messageId)).toEqual({
    kind: "invitation",
    event: {
      title: "Supplier review",
      location: "",
      time: TUESDAY_TEN,
      repeat: null,
      organiser: "Dana Wright",
      join: { service: "Google Meet", url: MEET, from: "conference" },
    },
    someDates: false,
    standing: {
      kind: "held",
      answer: "needsAnswer",
      cancelled: false,
      version: "same",
      confirmed: true,
      organiserTold: true,
    },
  });
});

test("an invitation from Outlook shows Join Microsoft Teams", async () => {
  const messageId = await arrive(
    invitationEmail({
      from: SAM,
      fromName: "Sam Okafor",
      auth: AUTH.proved("contoso.example"),
      method: "REQUEST",
      shape: "outlook",
      calendar: outlookCalendar("REQUEST", outlookEvent()),
    }),
  );
  expect(await readCard(messageId)).toMatchObject({
    kind: "invitation",
    event: {
      title: "Quarterly planning",
      location: "Microsoft Teams Meeting",
      organiser: "Sam Okafor",
      join: { service: "Microsoft Teams", url: TEAMS },
    },
    standing: { kind: "held", answer: "needsAnswer" },
  });
});

test("answering from the card sends the organiser one reply and records it in the calendar", async () => {
  const messageId = await arrive(google());

  await inMail().answerInvitationFromMail({
    data: { mailboxId: mailboxes.boss, messageId, answer: "yes" },
  });
  await calendars.settle();

  expect(email.sent.map((one) => [one.from, one.to])).toEqual([
    ["boss@example.com", DANA],
  ]);
  const reading = readCalendarFile(
    partOfType(readEmail(email.sent[0]!.raw), "text/calendar").body,
    SYDNEY,
  );
  if (reading.status !== "read") throw new Error(reading.status);
  expect(reading.method).toBe("reply");
  expect(reading.events).toMatchObject([
    {
      uid: GOOGLE_INVITE_UID,
      attendees: [{ email: "boss@example.com", answer: "accepted" }],
    },
  ]);
  expect((await schedule())[0]?.answer).toBe("yes");
  expect(await readCard(messageId)).toMatchObject({
    standing: { kind: "held", answer: "yes" },
  });
});

test("someone with no personal mailbox can answer from the card, which says first that the organiser won't hear", async () => {
  const messageId = await arrive(google(), "support@example.com");
  await inMail().addInvitationFromMail(target(messageId, mailboxes.support));
  kit.sqlite.run("DELETE FROM mailbox_access WHERE mailbox_id = ?", [
    mailboxes.boss,
  ]);

  expect(await readCard(messageId, mailboxes.support)).toMatchObject({
    standing: { kind: "held", answer: "needsAnswer", organiserTold: false },
  });
  await inMail().answerInvitationFromMail({
    data: { mailboxId: mailboxes.support, messageId, answer: "maybe" },
  });
  await calendars.settle();
  expect(email.sent).toEqual([]);
  expect((await schedule())[0]?.answer).toBe("maybe");
});

test("Add to my calendar adds an invitation from a shared mailbox once, unanswered, however often it's pressed", async () => {
  const messageId = await arrive(google(), "support@example.com");
  expect(await schedule()).toEqual([]);
  expect(await readCard(messageId, mailboxes.support)).toMatchObject({
    standing: { kind: "notHeld", addable: true },
  });

  await Promise.all([
    inMail().addInvitationFromMail(target(messageId, mailboxes.support)),
    inMail().addInvitationFromMail(target(messageId, mailboxes.support)),
  ]);
  await inMail().addInvitationFromMail(target(messageId, mailboxes.support));

  const shown = await schedule();
  expect(shown.map((one) => [one.title, one.answer])).toEqual([
    ["Supplier review", "needsAnswer"],
  ]);
  expect(shown[0]?.organiser).toMatchObject({
    kind: "outside",
    email: DANA,
    fromOrganiser: true,
  });
  expect(await readCard(messageId, mailboxes.support)).toMatchObject({
    standing: { kind: "held", answer: "needsAnswer" },
  });
  // Only the person who pressed it has it.
  expect(await schedule(jo)).toEqual([]);

  // Pressed again later, it leaves the answer given since.
  await inMail().answerInvitationFromMail({
    data: { mailboxId: mailboxes.support, messageId, answer: "yes" },
  });
  await inMail().addInvitationFromMail(target(messageId, mailboxes.support));
  expect((await schedule())[0]?.answer).toBe("yes");
});

test("Add to my calendar brings back a removed invitation, and its organiser's later changes reach it", async () => {
  const messageId = await arrive(google());
  await inCalendar().deleteEvent({
    data: {
      calendarId: await personalOf(),
      target: { uid: (await schedule())[0]!.uid, occurrenceId: null },
      scope: "all",
    },
  });
  expect(await readCard(messageId)).toMatchObject({
    standing: { kind: "removed", addable: true },
  });

  await inMail().addInvitationFromMail(target(messageId));
  expect((await schedule()).map((one) => [one.title, one.answer])).toEqual([
    ["Supplier review", "needsAnswer"],
  ]);
  await arrive(google({ sequence: 1, title: "Supplier review, moved" }));
  expect((await schedule()).map((one) => one.title)).toEqual([
    "Supplier review, moved",
  ]);
  // The first email is older than the calendar now.
  expect(await readCard(messageId)).toMatchObject({
    event: { title: "Supplier review, moved" },
    standing: { kind: "held", version: "later" },
  });
});

test("an email that changes only one date offers nothing to add, and makes no calendar", async () => {
  const messageId = await arrive(
    google({ recurrenceId: "20261110T100000", sequence: 1 }),
    "support@example.com",
  );
  expect(await readCard(messageId, mailboxes.support)).toMatchObject({
    someDates: true,
    standing: { kind: "notHeld", addable: false },
  });
  expect(
    await refusalOf(
      inMail().addInvitationFromMail(target(messageId, mailboxes.support)),
    ),
  ).toMatchObject({ status: 409 });
  expect((await inCalendar().getCalendars())[0]?.id).toBeNull();
});

test("imported mail, and mail that came while Calendar was off, offer Add to my calendar", async () => {
  const imported = await ingest(mail.env, {
    source: "import",
    mailboxId: mailboxes.boss,
    raw: new TextEncoder().encode(google({ uid: "import@google.com" }))
      .buffer as ArrayBuffer,
  });
  if (imported.status === "tooLarge") throw new Error(imported.status);
  await handOver();
  expect(await readCard(imported.messageId)).toMatchObject({
    standing: { kind: "notHeld", addable: true },
  });

  kit.sqlite.run(
    "INSERT INTO app_settings (app, enabled) VALUES ('calendar', 0)",
  );
  const whileOff = await arrive(google({ uid: "off@google.com" }));
  kit.sqlite.run("DELETE FROM app_settings");
  expect(await schedule()).toEqual([]);
  expect(await readCard(whileOff)).toMatchObject({
    standing: { kind: "notHeld", addable: true },
  });

  await inMail().addInvitationFromMail(target(imported.messageId));
  // An imported message proves nothing about its sender.
  expect((await schedule())[0]?.organiser).toMatchObject({
    fromOrganiser: false,
  });
});

test("an update shows what the calendar holds, and says when the sender couldn't be confirmed", async () => {
  const first = await arrive(google());
  const moved = { sequence: 1, title: "Supplier review, moved" };

  const forged = await arrive(google(moved, { auth: AUTH.failed(PARTNER) }));
  expect(await readCard(forged)).toMatchObject({
    event: { title: "Supplier review" },
    standing: { kind: "held", version: "earlier", confirmed: false },
  });

  const real = await arrive(google(moved));
  expect(await readCard(real)).toMatchObject({
    event: { title: "Supplier review, moved" },
    standing: { kind: "held", version: "same", confirmed: true },
  });
  expect(await readCard(first)).toMatchObject({
    standing: { kind: "held", version: "later" },
  });
});

// The words on the card as Mail's reading pane shows them.
async function cardText(messageId: MessageId) {
  const card = await readCard(messageId);
  if (!card) throw new Error("no card");
  const markup = renderToStaticMarkup(
    createElement(MailInvitationCard, {
      card,
      actions: {
        answer: async () => {},
        add: async () => {},
        remove: async () => {},
      },
    }),
  );
  return markup.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'");
}

test("an email that changes one date says when the sender couldn't be confirmed", async () => {
  await arrive(google());
  const oneDate = { recurrenceId: "20261110T100000", sequence: 0 };

  const forged = await arrive(
    google({ ...oneDate, title: "Pay invoice at evil" }, { from: MALLORY }),
  );
  expect(await cardText(forged)).toContain(
    "the sender couldn't be confirmed, so your calendar keeps it as it was",
  );

  const real = await arrive(google({ ...oneDate, title: "Moved review" }));
  expect(await cardText(real)).not.toContain("couldn't be confirmed");
});

test("a cancellation shows as cancelled, with Remove from my calendar while it's held", async () => {
  const invitation = await arrive(google());
  const forged = await arrive(
    google(
      { sequence: 1, status: "CANCELLED", title: "Off, see my new invite" },
      { method: "CANCEL", auth: AUTH.failed(PARTNER) },
    ),
  );
  // The event shows as the calendar still holds it.
  expect(await readCard(forged)).toMatchObject({
    kind: "cancellation",
    event: { title: "Supplier review", join: null },
    standing: { kind: "held", cancelled: false, confirmed: false },
  });

  const real = await arrive(
    google({ sequence: 1, status: "CANCELLED" }, { method: "CANCEL" }),
  );
  expect(await readCard(real)).toMatchObject({
    kind: "cancellation",
    standing: { kind: "held", cancelled: true, confirmed: true },
  });
  // The invitation's own card says so too, with no Join.
  expect(await readCard(invitation)).toMatchObject({
    event: { join: null },
    standing: { kind: "held", cancelled: true },
  });
  expect(
    await refusalOf(
      inMail().answerInvitationFromMail({
        data: {
          mailboxId: mailboxes.boss,
          messageId: invitation,
          answer: "yes",
        },
      }),
    ),
  ).toMatchObject({ status: 409 });

  await inMail().removeInvitationFromMail(target(real));
  await inMail().removeInvitationFromMail(target(real));
  expect(await schedule()).toEqual([]);
  expect(await readCard(real)).toMatchObject({
    standing: { kind: "notHeld" },
  });
});

test("a reply says who answered and whether it was recorded, or that the sender couldn't be confirmed", async () => {
  const personal = await ensurePersonalCalendar(kit.database, kit.admin);
  const { uid } = await inCalendar().createEvent({
    data: {
      calendarId: personal,
      draft: {
        title: "Weekly planning",
        location: "",
        notes: "",
        time: TUESDAY_TEN,
        repeat: null,
        people: [{ email: DANA as EmailAddress }],
      },
    },
  });
  await calendars.settle();
  const reply = (from: string, auth: string, partstat: string, about = uid) =>
    invitationEmail({
      from,
      auth,
      method: "REPLY",
      subject: "Accepted: Weekly planning",
      // A reply's own text is the sender's to write.
      calendar: googleReply(about, DANA, partstat).replace(
        "SUMMARY:Weekly planning",
        "SUMMARY:Pay invoice 4471 today",
      ),
    });

  const forged = await arrive(reply(MALLORY, AUTH.proved(PARTNER), "DECLINED"));
  expect(await readCard(forged)).toMatchObject({
    kind: "reply",
    event: { title: "Pay invoice 4471 today", organiser: null },
    who: "Dana Wright",
    answer: "no",
    standing: { kind: "notConfirmed" },
  });
  // Their own address, but the mail can't show it came from there.
  const unproved = await arrive(reply(DANA, AUTH.failed(PARTNER), "DECLINED"));
  expect(await readCard(unproved)).toMatchObject({
    standing: { kind: "notConfirmed" },
  });

  const accepted = await arrive(reply(DANA, AUTH.proved(PARTNER), "ACCEPTED"));
  expect(await readCard(accepted)).toMatchObject({
    kind: "reply",
    event: {
      title: "Weekly planning",
      time: TUESDAY_TEN,
      organiser: null,
      join: null,
    },
    who: "Dana Wright",
    answer: "yes",
    standing: { kind: "held", answer: "yes" },
  });

  const later = await arrive(reply(DANA, AUTH.proved(PARTNER), "TENTATIVE"));
  expect(await readCard(later)).toMatchObject({
    standing: { kind: "held", answer: "maybe" },
  });
  // The earlier reply now shows the answer the calendar holds.
  expect(await readCard(accepted)).toMatchObject({
    answer: "yes",
    standing: { kind: "held", answer: "maybe" },
  });

  const unknown = await arrive(
    reply(
      DANA,
      AUTH.proved(PARTNER),
      "ACCEPTED",
      "not-ours@google.com" as EventUid,
    ),
  );
  expect(await readCard(unknown)).toMatchObject({
    standing: { kind: "noEvent" },
  });
});

test("with Calendar off, the card shows the invitation as plain details, and refuses to answer, add, or remove", async () => {
  const messageId = await arrive(google());
  kit.sqlite.run(
    "INSERT INTO app_settings (app, enabled) VALUES ('calendar', 0)",
  );

  expect(await readCard(messageId)).toEqual({
    kind: "invitation",
    event: {
      title: "Supplier review",
      location: "",
      time: TUESDAY_TEN,
      repeat: null,
      organiser: "Dana Wright",
      join: { service: "Google Meet", url: MEET, from: "conference" },
    },
    someDates: false,
    standing: { kind: "calendarOff" },
  });
  for (const action of [
    inMail().answerInvitationFromMail({
      data: { mailboxId: mailboxes.boss, messageId, answer: "yes" },
    }),
    inMail().addInvitationFromMail(target(messageId)),
    inMail().removeInvitationFromMail(target(messageId)),
  ]) {
    expect(await refusalOf(action)).toEqual({
      status: 403,
      message:
        "An admin turned Calendar off, so invitations can't be answered or added from Mail. Nothing was changed. Ask your admin to turn Calendar back on.",
    });
  }
  kit.sqlite.run("DELETE FROM app_settings");
  expect((await schedule())[0]?.answer).toBe("needsAnswer");
});

test("with Mail off, the card's functions refuse", async () => {
  const messageId = await arrive(google());
  kit.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
  expect(await refusalOf(readCard(messageId))).toMatchObject({
    status: 403,
  });
  expect(
    await refusalOf(
      inMail().answerInvitationFromMail({
        data: { mailboxId: mailboxes.boss, messageId, answer: "yes" },
      }),
    ),
  ).toMatchObject({ status: 403 });
  expect(
    await refusalOf(inMail().addInvitationFromMail(target(messageId))),
  ).toMatchObject({ status: 403 });
});

test("someone who can't open the mailbox gets nothing from its invitations", async () => {
  const messageId = await arrive(google());
  const refused = {
    status: 403,
    message:
      "You don't have access to this mailbox. Ask your admin if you need it.",
  };
  expect(await refusalOf(readCard(messageId, mailboxes.boss, jo))).toEqual(
    refused,
  );
  expect(
    await refusalOf(inMail(jo).addInvitationFromMail(target(messageId))),
  ).toEqual(refused);
  expect(
    await refusalOf(
      inMail(jo).answerInvitationFromMail({
        data: { mailboxId: mailboxes.boss, messageId, answer: "no" },
      }),
    ),
  ).toEqual(refused);
  expect(await schedule(jo)).toEqual([]);
  expect((await schedule())[0]?.answer).toBe("needsAnswer");
});

async function inviteFrom(calendarId: CalendarId, people: PersonToInvite[]) {
  const { uid } = await inCalendar().createEvent({
    data: {
      calendarId,
      draft: {
        title: "Weekly planning",
        location: "",
        notes: "",
        time: TUESDAY_TEN,
        repeat: null,
        people,
      },
    },
  });
  await calendars.settle();
  return uid as EventUid;
}

test("a colleague's invitation email shows the copy their calendar sent, answers it, and adds nothing beside it", async () => {
  await inviteFrom(TEAM, [jo]);
  const [invitation] = email.sent.filter((one) => one.to === "jo@example.com");
  const messageId = await arrive(
    [
      `Authentication-Results: ${AUTH.proved("example.com")}`,
      invitation!.raw,
    ].join("\r\n"),
    "jo@example.com",
  );
  expect(await readCard(messageId, mailboxes.jo, jo)).toMatchObject({
    kind: "invitation",
    event: { title: "Weekly planning", organiser: "Boss" },
    standing: { kind: "held", answer: "needsAnswer", organiserTold: true },
  });

  await inMail(jo).answerInvitationFromMail({
    data: { mailboxId: mailboxes.jo, messageId, answer: "yes" },
  });
  await inMail(jo).addInvitationFromMail(target(messageId, mailboxes.jo));
  await calendars.settle();
  expect((await schedule(jo)).map((one) => [one.title, one.answer])).toEqual([
    ["Weekly planning", "yes"],
  ]);
  const [organisers] = await schedule();
  expect(organisers?.people.map((one) => [one.name, one.answer])).toEqual([
    ["Jo Okafor", "yes"],
  ]);

  // Removed, it comes back from the calendar that sent it, and answers still reach it.
  const [copy] = await schedule(jo);
  await inCalendar(jo).deleteEvent({
    data: {
      calendarId: await personalOf(jo),
      target: { uid: copy!.uid, occurrenceId: null },
      scope: "all",
    },
  });
  expect(await readCard(messageId, mailboxes.jo, jo)).toMatchObject({
    standing: { kind: "removed", addable: true },
  });
  // A copy of it that can't show it came from the organiser can't bring it back.
  const unproved = await arrive(invitation!.raw, "jo@example.com");
  expect(await readCard(unproved, mailboxes.jo, jo)).toMatchObject({
    standing: { kind: "removed", addable: false },
  });
  expect(
    await refusalOf(
      inMail(jo).addInvitationFromMail(target(unproved, mailboxes.jo)),
    ),
  ).toMatchObject({ status: 409 });
  expect(await schedule(jo)).toEqual([]);
  await inMail(jo).addInvitationFromMail(target(messageId, mailboxes.jo));
  expect((await schedule(jo)).map((one) => [one.uid, one.answer])).toEqual([
    [copy!.uid, "needsAnswer"],
  ]);
  await inMail(jo).answerInvitationFromMail({
    data: { mailboxId: mailboxes.jo, messageId, answer: "no" },
  });
  await calendars.settle();
  expect((await schedule())[0]?.people.map((one) => one.answer)).toEqual([
    "no",
  ]);
});

test("a colleague's invitation that never reached the calendar offers nothing to add", async () => {
  await inviteFrom(TEAM, [{ email: "support@example.com" as EmailAddress }]);
  const [invitation] = email.sent;
  const messageId = await arrive(
    [
      `Authentication-Results: ${AUTH.proved("example.com")}`,
      invitation!.raw,
    ].join("\r\n"),
    "support@example.com",
  );
  kit.sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'member')",
    [mailboxes.support, jo],
  );
  expect(await readCard(messageId, mailboxes.support, jo)).toMatchObject({
    standing: { kind: "notHeld", addable: false },
  });
  expect(
    await refusalOf(
      inMail(jo).addInvitationFromMail(target(messageId, mailboxes.support)),
    ),
  ).toMatchObject({ status: 409 });
  expect(await schedule(jo)).toEqual([]);
});

test("hostile calendar parts stay plain text, give no Join for a look-alike link, and are read only within their limits", async () => {
  const hostile = googleCalendar(
    "REQUEST",
    googleEvent({
      uid: "hostile@google.com",
      title: '<img src=x onerror="alert(1)"> Review',
      organiser: DANA,
      extra: [
        "LOCATION:https://meet.google.com@evil.example/abc javascript:alert(1)",
      ],
    }).filter(
      (line) =>
        !line.startsWith("X-GOOGLE-CONFERENCE") &&
        !line.startsWith("DESCRIPTION") &&
        line !== "LOCATION:",
    ),
  );
  const named = hostile.replace(
    "ORGANIZER;CN=Dana Wright",
    `ORGANIZER;CN=${"Dana ".repeat(60)}`,
  );
  const messageId = await arrive(
    invitationEmail({
      from: DANA,
      auth: AUTH.proved(PARTNER),
      method: "REQUEST",
      calendar: named,
    }),
    "support@example.com",
  );
  const shown = await readCard(messageId, mailboxes.support);
  expect(shown).toMatchObject({
    event: {
      title: '<img src=x onerror="alert(1)"> Review',
      location: "https://meet.google.com@evil.example/abc javascript:alert(1)",
      join: null,
    },
  });
  expect(shown?.event.organiser?.length).toBe(100);

  // A part over the limit is never read, and neither is a fourth.
  const big = googleCalendar(
    "REQUEST",
    googleEvent({
      uid: "big@google.com",
      extra: [`COMMENT:${"x".repeat(300 * 1024)}`],
    }),
  );
  const tooBig = await arrive(
    invitationEmail({
      from: DANA,
      auth: AUTH.proved(PARTNER),
      method: "REQUEST",
      calendar: big,
      shape: "outlook",
    }),
    "support@example.com",
  );
  expect(await readCard(tooBig, mailboxes.support)).toBeNull();

  // A published file is no invitation, so the only one here is the last part.
  const published = googleCalendar("PUBLISH" as "REQUEST", googleEvent());
  const invited = googleCalendar("REQUEST", googleEvent());
  const withParts = (...parts: string[]) =>
    arrive(
      invitationEmail({
        from: DANA,
        auth: AUTH.proved(PARTNER),
        method: "REQUEST",
        shape: "outlook",
        calendar: published,
        parts,
      }),
      "support@example.com",
    );
  const third = await withParts(
    calendarAttachment(published),
    calendarAttachment(invited),
  );
  expect(await readCard(third, mailboxes.support)).toMatchObject({
    kind: "invitation",
  });
  const fourth = await withParts(
    calendarAttachment(published),
    calendarAttachment(published),
    calendarAttachment(invited),
  );
  expect(await readCard(fourth, mailboxes.support)).toBeNull();
});
