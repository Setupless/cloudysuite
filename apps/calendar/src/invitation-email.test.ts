import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { CalendarRole, UserId } from "@cloudysuite/access";
import { testWorkerEnv } from "../../../src/db/test-database";
import { readRequestFrom } from "../../../src/test-server-fn";
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
  type SentEmail,
} from "@cloudysuite/app-email/test-support";
import { readCalendarFile } from "./outside/ics";
import { GOOGLE_EXPORT } from "./outside/test-support";
import { createCalendarTest, SYDNEY, saved, TEAM } from "./test-support";
import {
  CALENDAR_GONE_MESSAGE,
  type CalendarOccurrence,
  type CivilDate,
  type EmailAddress,
  type EventDraft,
  type EventTime,
  type EventUid,
  type NotSentReason,
  type OccurrenceId,
  type PersonKey,
  type PersonToInvite,
  type UnsentCancellation,
} from "./types";

let request: Request;
readRequestFrom(() => request);
const functions = await import("./functions");

const env = testWorkerEnv as unknown as Record<string, unknown>;
let kit: Kit;
let objects: Awaited<ReturnType<typeof createCalendarTest>>;
let email: ReturnType<typeof createFakeEmail>;
const cookies = new Map<UserId, string>();
const people = {} as Record<CalendarRole | "colleague", UserId>;
const OUTSIDE = "dana@partner.example.org" as EmailAddress;
const NOW = Date.parse("2026-11-05T09:00:00+11:00");

beforeEach(async () => {
  setSystemTime(new Date(NOW));
  kit = await createKit();
  objects = await createCalendarTest();
  email = createFakeEmail();
  env.DB = kit.database;
  env.CALENDAR = objects.env.CALENDAR;
  env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
  const objectEnv = objects.env as unknown as Record<string, unknown>;
  objectEnv.DB = kit.database;
  objectEnv.EMAIL = email.binding;
  people.manager = kit.admin;
  const emails = new Map([[kit.admin, "boss@example.com"]]);
  for (const [role, name, address] of [
    ["editor", "Maya Chen", "maya@example.com"],
    ["viewer", "Ravi Patel", "ravi@example.com"],
    ["colleague", "Jo Okafor", "jo@example.com"],
  ] as const) {
    const { user } = await kit.auth.api.createUser({
      body: { email: address, password: PASSWORD, name },
    });
    people[role] = user.id as UserId;
    emails.set(people[role], address);
  }
  for (const [id, address] of emails) {
    kit.sqlite.run("DELETE FROM rate_limit");
    cookies.set(id, (await signIn(kit, address)).headers.get("set-cookie")!);
    giveMailbox(id, address);
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

afterEach(() => {
  setSystemTime();
});

function giveMailbox(userId: UserId, address: string) {
  const mailboxId = crypto.randomUUID();
  kit.sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'personal', 'Own')",
    [mailboxId],
  );
  kit.sqlite.run(
    "INSERT INTO addresses (address, domain, mailbox_id, kind) VALUES (?, 'example.com', ?, 'primary')",
    [address, mailboxId],
  );
  kit.sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'manager')",
    [mailboxId, userId],
  );
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

const timed = (from: string, to: string): EventTime =>
  ({
    kind: "timed",
    start: Date.parse(from),
    end: Date.parse(to),
    timeZone: SYDNEY,
  }) as EventTime;

const TUESDAY = timed("2026-11-10T10:00:00+11:00", "2026-11-10T11:00:00+11:00");
const WEEKLY = { frequency: "weekly", end: { kind: "never" } } as const;
// The second Tuesday, as its RECURRENCE-ID.
const SECOND = "20261116T230000Z" as OccurrenceId;

const planning = (more: Partial<EventDraft> = {}): EventDraft => ({
  title: "Weekly planning",
  location: "Room 4",
  notes: "Bring the numbers.",
  time: TUESDAY,
  repeat: null,
  people: [],
  ...more,
});

const outside = (address: string): PersonToInvite => ({
  email: address as EmailAddress,
});

async function invite(
  invited: PersonToInvite[],
  more: Partial<EventDraft> = {},
  by: UserId = people.manager,
) {
  const { uid } = saved(
    await as(by).createEvent({
      data: { calendarId: TEAM, draft: planning({ people: invited, ...more }) },
    }),
  );
  await objects.settle();
  return uid;
}

async function change(
  uid: EventUid,
  more: Partial<EventDraft>,
  by: UserId = people.manager,
) {
  await as(by).updateEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: null },
      scope: "all",
      draft: planning(more),
    },
  });
  await objects.settle();
}

// Runs the next wake-up, which must be later than now.
async function wakeLater() {
  const next = objects.alarmOf(TEAM);
  expect(next).toBeGreaterThan(Date.now());
  setSystemTime(new Date(next!));
  await objects.settle();
}

// The team's own event, as its People list shows it.
async function organisersView(): Promise<CalendarOccurrence> {
  const { occurrences } = await as(people.manager).listEvents({
    data: {
      from: "2026-11-09" as CivilDate,
      to: "2026-12-07" as CivilDate,
      timeZone: SYDNEY,
    },
  });
  const own = occurrences.find((one) => one.calendarId === TEAM);
  if (!own) throw new Error("expected the team's event");
  return own;
}

const notSent = async () =>
  Object.fromEntries(
    (await organisersView()).people.flatMap((person) =>
      person.notSent ? [[person.name, person.notSent]] : [],
    ),
  );

const sentTo = (address: string) =>
  email.sent.filter((one) => one.to === address);

function invitationIn(message: SentEmail) {
  const read = readEmail(message.raw);
  const calendar = partOfType(read, "text/calendar");
  const reading = readCalendarFile(calendar.body, SYDNEY);
  if (reading.status !== "read") throw new Error("expected a calendar file");
  return { read, calendar, ics: calendar.body, events: reading.events };
}

test("everyone invited gets one email of their own, from the organiser's own address", async () => {
  const uid = await invite([people.colleague, outside(OUTSIDE)]);

  expect(email.sent.map((one) => [one.from, one.to]).sort()).toEqual([
    ["boss@example.com", "dana@partner.example.org"],
    ["boss@example.com", "jo@example.com"],
  ]);
  for (const message of email.sent) {
    const { read, calendar, events } = invitationIn(message);
    expect(read.headers.get("from")).toBe('"Boss" <boss@example.com>');
    expect(read.subject).toBe(
      "Invitation: Weekly planning, Tue 10 Nov, 10:00 to 11:00 (Australia/Sydney)",
    );
    expect(calendar.headers.get("content-type")).toBe(
      "text/calendar; charset=UTF-8; method=REQUEST",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid,
      title: "Weekly planning",
      location: "Room 4",
      notes: "Bring the numbers.",
      time: TUESDAY,
      sequence: 0,
      cancelled: false,
      organiser: { email: "boss@example.com", name: "Boss" },
      attendees: [
        { email: "jo@example.com", name: "Jo Okafor", answer: "needsAction" },
        { email: OUTSIDE, name: null, answer: "needsAction" },
      ],
    });
  }
  // The colleague still gets the event straight in their own calendar.
  const { occurrences } = await as(people.colleague).listEvents({
    data: {
      from: "2026-11-09" as CivilDate,
      to: "2026-11-16" as CivilDate,
      timeZone: SYDNEY,
    },
  });
  expect(occurrences.map((one) => one.title)).toEqual(["Weekly planning"]);
  // The People list shows the address, with no answer yet.
  expect(
    (await organisersView()).people.map((person) => [person.kind, person.name]),
  ).toEqual([
    ["colleague", "Jo Okafor"],
    ["outside", OUTSIDE],
  ]);
});

test("the email carries text, simple HTML and the invitation, with nothing from the event as markup", async () => {
  await invite([outside(OUTSIDE)], {
    title: "Plan <b>this</b>\r\nBcc: someone@evil.example",
    notes: "<script>alert(1)</script>\nSecond line",
  });
  const [message] = email.sent;
  const read = readEmail(message!.raw);
  expect([...read.headers.keys()]).not.toContain("bcc");
  expect(read.subject).toStartWith(
    "Invitation: Plan <b>this</b> Bcc: someone@evil.example, Tue 10 Nov",
  );
  const html = partOfType(read, "text/html").body;
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<b>");
  expect(partOfType(read, "text/plain").body).toContain(
    "Notes:\n<script>alert(1)</script>\nSecond line",
  );
  const attachment = partOfType(read, "application/ics");
  expect(attachment.headers.get("content-disposition")).toBe(
    'attachment; filename="invite.ics"',
  );
  expect(attachment.body).toBe(partOfType(read, "text/calendar").body);
  // Every line of the invitation fits RFC 5545's 75 octets.
  for (const line of attachment.body.split("\r\n")) {
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
  }
});

test("a change sends an update at a higher sequence, and deleting it sends a cancellation", async () => {
  const uid = await invite([people.colleague, outside(OUTSIDE)]);
  await change(uid, {
    title: "Planning, moved",
    people: [people.colleague, outside(OUTSIDE)],
  });
  const [update] = sentTo(OUTSIDE).slice(1);
  const updated = invitationIn(update!);
  expect(updated.read.subject).toBe(
    "Updated invitation: Planning, moved, Tue 10 Nov, 10:00 to 11:00 (Australia/Sydney)",
  );
  expect(updated.events[0]).toMatchObject({ uid, sequence: 1 });

  await as(people.manager).deleteEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: null },
      scope: "all",
    },
  });
  await objects.settle();
  for (const address of [OUTSIDE, "jo@example.com"]) {
    const messages = sentTo(address);
    expect(messages).toHaveLength(3);
    const cancelled = invitationIn(messages[2]!);
    expect(cancelled.read.subject).toBe(
      "Cancelled: Planning, moved, Tue 10 Nov, 10:00 to 11:00 (Australia/Sydney)",
    );
    expect(cancelled.calendar.headers.get("content-type")).toBe(
      "text/calendar; charset=UTF-8; method=CANCEL",
    );
    expect(cancelled.ics).toContain("METHOD:CANCEL");
    expect(cancelled.events[0]).toMatchObject({
      uid,
      cancelled: true,
      sequence: 2,
    });
  }
  expect(objects.alarmOf(TEAM)).toBeNull();
});

test("someone taken off the list is told it's off, and someone never sent anything isn't", async () => {
  const uid = await invite([outside(OUTSIDE)]);
  await as(people.manager).updateEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: null },
      scope: "all",
      draft: planning({ people: [outside("late@partner.example.org")] }),
    },
  });
  await as(people.manager).updateEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: null },
      scope: "all",
      draft: planning({ people: [] }),
    },
  });
  await objects.settle();
  expect(sentTo("late@partner.example.org")).toEqual([]);
  const [, off] = sentTo(OUTSIDE);
  const cancelled = invitationIn(off!);
  expect(cancelled.read.subject).toStartWith("Cancelled: Weekly planning");
  expect(partOfType(cancelled.read, "text/plain").body).toContain(
    "so you're no longer invited",
  );
  expect(cancelled.events[0]).toMatchObject({
    uid,
    sequence: 2,
    cancelled: true,
  });
});

test("an editor's change goes out from the organiser's address", async () => {
  const uid = await invite([outside(OUTSIDE)]);
  await change(
    uid,
    { title: "Planning, by Maya", people: [outside(OUTSIDE)] },
    people.editor,
  );
  const update = sentTo(OUTSIDE)[1]!;
  expect(update.from).toBe("boss@example.com");
  expect(readEmail(update.raw).headers.get("from")).toBe(
    '"Boss" <boss@example.com>',
  );
  expect(invitationIn(update).events[0]?.organiser).toEqual({
    email: "boss@example.com" as EmailAddress,
    name: "Boss",
  });
});

test("nothing goes once the organiser is suspended, their address leaves their mailbox, or Mail or Calendar is off", async () => {
  const banned = (on: boolean) =>
    kit.sqlite.run("UPDATE user SET banned = ? WHERE id = ?", [
      on ? 1 : 0,
      people.manager,
    ]);
  const cases: [string, () => void, () => void, NotSentReason][] = [
    // The organiser made the change, so it's theirs that can't be made now.
    ["suspended", () => banned(true), () => banned(false), "changerCantEdit"],
    [
      "address gone",
      () =>
        kit.sqlite.run(
          "DELETE FROM addresses WHERE address = 'boss@example.com'",
        ),
      () => giveMailbox(people.manager, "boss@example.com"),
      "noSender",
    ],
    [
      "Mail off",
      () =>
        kit.sqlite.run(
          "INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)",
        ),
      () => kit.sqlite.run("DELETE FROM app_settings"),
      "mailOff",
    ],
    [
      "Calendar off",
      () =>
        kit.sqlite.run(
          "INSERT INTO app_settings (app, enabled) VALUES ('calendar', 0)",
        ),
      () => kit.sqlite.run("DELETE FROM app_settings"),
      "calendarOff",
    ],
  ];
  for (const [name, before, after, reason] of cases) {
    const { uid } = saved(
      await as(people.manager).createEvent({
        data: {
          calendarId: TEAM,
          draft: planning({ title: name, people: [outside(OUTSIDE)] }),
        },
      }),
    );
    before();
    await objects.settle();
    after();
    expect([name, email.attempts]).toEqual([name, []]);
    const { occurrences } = await as(people.manager).listEvents({
      data: {
        from: "2026-11-09" as CivilDate,
        to: "2026-11-16" as CivilDate,
        timeZone: SYDNEY,
      },
    });
    const event = occurrences.find((one) => one.uid === uid);
    expect([name, event?.people[0]?.notSent]).toEqual([
      name,
      { kind: "refused", reason },
    ]);
  }
});

test("an editor's change to a suspended organiser's event doesn't go from their address", async () => {
  const uid = await invite([outside(OUTSIDE)]);
  kit.sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [people.manager]);
  await change(
    uid,
    { title: "Planning, moved", people: [outside(OUTSIDE)] },
    people.editor,
  );
  expect(sentTo(OUTSIDE)).toHaveLength(1);
  kit.sqlite.run("UPDATE user SET banned = 0 WHERE id = ?", [people.manager]);
  expect(await notSent()).toEqual({
    [OUTSIDE]: { kind: "refused", reason: "noSender" },
  });
});

test("an email whose change came from someone who can no longer edit doesn't go", async () => {
  await as(people.editor).createEvent({
    data: { calendarId: TEAM, draft: planning({ people: [outside(OUTSIDE)] }) },
  });
  kit.sqlite.run(
    "UPDATE calendar_access SET role = 'viewer' WHERE user_id = ?",
    [people.editor],
  );
  await objects.settle();
  expect(email.attempts).toEqual([]);
  expect(await notSent()).toEqual({
    [OUTSIDE]: { kind: "refused", reason: "changerCantEdit" },
  });
});

test("a rate limit is tried again later, and then sends once", async () => {
  email.willEnd({ kind: "refused", code: "E_RATE_LIMIT_EXCEEDED" });
  await invite([outside(OUTSIDE)]);
  expect(email.sent).toEqual([]);
  expect(await notSent()).toEqual({});
  await wakeLater();
  expect(email.attempts).toHaveLength(2);
  expect(sentTo(OUTSIDE)).toHaveLength(1);
  expect(objects.alarmOf(TEAM)).toBeNull();
});

test("rate limits that never clear end as not sent, with no endless retries", async () => {
  email.willEnd(
    ...Array.from({ length: 4 }, () => ({
      kind: "refused" as const,
      code: "E_RATE_LIMIT_EXCEEDED",
    })),
  );
  await invite([outside(OUTSIDE)]);
  for (let tries = 0; tries < 3; tries++) await wakeLater();
  expect(email.attempts).toHaveLength(4);
  expect(email.sent).toEqual([]);
  expect(await notSent()).toEqual({
    [OUTSIDE]: { kind: "refused", reason: "rateLimited" },
  });
  expect(objects.alarmOf(TEAM)).toBeNull();
});

test("an unclear send is never tried again by itself, and Try again sends it once", async () => {
  email.willEnd({ kind: "unclear" });
  const uid = await invite([outside(OUTSIDE)]);
  expect(await notSent()).toEqual({ [OUTSIDE]: { kind: "unclear" } });
  expect(objects.alarmOf(TEAM)).toBeNull();

  const retry = () =>
    as(people.editor).retryInvitationEmail({
      data: { calendarId: TEAM, uid, recipient: `mailto:${OUTSIDE}` },
    });
  await retry();
  await retry();
  await objects.settle();
  expect(email.attempts).toHaveLength(2);
  expect(sentTo(OUTSIDE)).toHaveLength(1);
  expect(await notSent()).toEqual({});
  // It may have gone the first time, so this one says it's an update.
  expect(readEmail(sentTo(OUTSIDE)[0]!.raw).subject).toStartWith(
    "Updated invitation:",
  );
});

test("a refused email shows as not sent, and Try again sends it exactly once", async () => {
  email.willEnd({ kind: "refused", code: "E_RECIPIENT_SUPPRESSED" });
  const uid = await invite([outside(OUTSIDE)]);
  expect(await notSent()).toEqual({
    [OUTSIDE]: { kind: "refused", reason: "recipientSuppressed" },
  });
  const tryAgain = (by: UserId) =>
    as(by).retryInvitationEmail({
      data: { calendarId: TEAM, uid, recipient: `mailto:${OUTSIDE}` },
    });
  expect(await refused(tryAgain(people.viewer))).toMatchObject({
    status: 403,
  });

  await tryAgain(people.manager);
  await tryAgain(people.manager);
  await objects.settle();
  await tryAgain(people.manager);
  await objects.settle();
  expect(email.attempts).toHaveLength(2);
  expect(sentTo(OUTSIDE)).toHaveLength(1);
  expect(readEmail(sentTo(OUTSIDE)[0]!.raw).subject).toStartWith("Invitation:");
  expect(await notSent()).toEqual({});
});

test("someone taken off whose cancellation didn't go stays on People as taken off, until Try again sends it once", async () => {
  const uid = await invite([people.colleague, outside(OUTSIDE)]);
  email.willEnd(
    { kind: "refused", code: "E_RECIPIENT_SUPPRESSED" },
    { kind: "refused", code: "E_RECIPIENT_SUPPRESSED" },
  );
  await change(uid, { people: [] });
  const shown = await organisersView();
  expect(shown.people).toEqual([]);
  expect(
    shown.takenOff.toSorted((a, b) => a.name.localeCompare(b.name)),
  ).toEqual([
    {
      key: `mailto:${OUTSIDE}` as PersonKey,
      name: OUTSIDE,
      notSent: { kind: "refused", reason: "recipientSuppressed" },
    },
    {
      key: `user:${people.colleague}` as PersonKey,
      name: "Jo Okafor",
      notSent: { kind: "refused", reason: "recipientSuppressed" },
    },
  ]);
  const tryAgain = (by: UserId) =>
    as(by).retryInvitationEmail({
      data: { calendarId: TEAM, uid, recipient: `mailto:${OUTSIDE}` },
    });
  expect(await refused(tryAgain(people.viewer))).toMatchObject({
    status: 403,
  });

  await tryAgain(people.manager);
  await tryAgain(people.manager);
  await objects.settle();
  const [, cancellation, ...more] = sentTo(OUTSIDE);
  expect(more).toEqual([]);
  expect(invitationIn(cancellation!).read.subject).toStartWith(
    "Cancelled: Weekly planning",
  );
  expect((await organisersView()).takenOff.map((one) => one.name)).toEqual([
    "Jo Okafor",
  ]);
});

test("a deleted event's cancellation that didn't go is listed in the calendar's settings, until Try again sends it once", async () => {
  const uid = await invite([outside(OUTSIDE)]);
  email.willEnd({ kind: "unclear" });
  await as(people.manager).deleteEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: null },
      scope: "all",
    },
  });
  await objects.settle();
  const unsent: UnsentCancellation[] = [
    {
      uid,
      title: "Weekly planning",
      time: TUESDAY,
      to: {
        key: `mailto:${OUTSIDE}` as PersonKey,
        name: OUTSIDE,
        notSent: { kind: "unclear" },
      },
    },
  ];
  const list = (by: UserId) =>
    as(by).listUnsentCancellations({ data: { calendarId: TEAM } });
  expect(await list(people.viewer)).toEqual(unsent);
  // Someone not on the calendar learns nothing about it.
  expect((await refused(list(people.colleague))).status).toBe(403);
  const tryAgain = (by: UserId) =>
    as(by).retryInvitationEmail({
      data: { calendarId: TEAM, uid, recipient: `mailto:${OUTSIDE}` },
    });
  expect(await refused(tryAgain(people.viewer))).toMatchObject({
    status: 403,
  });

  await tryAgain(people.editor);
  await tryAgain(people.editor);
  await objects.settle();
  expect(email.attempts).toHaveLength(3);
  const [, cancellation, ...more] = sentTo(OUTSIDE);
  expect(more).toEqual([]);
  expect(invitationIn(cancellation!).read.subject).toStartWith(
    "Cancelled: Weekly planning",
  );
  expect(await list(people.manager)).toEqual([]);
});

test("an object stopped after claiming a send finds it unclear, and never sends it twice", async () => {
  objects.stopping.add(TEAM);
  await invite([outside(OUTSIDE)]);
  objects.stopping.delete(TEAM);
  await wakeLater();
  expect(email.attempts).toEqual([]);
  expect(await notSent()).toEqual({ [OUTSIDE]: { kind: "unclear" } });
  expect(objects.alarmOf(TEAM)).toBeNull();
});

test("an address can't be invited while Mail is off, or by someone with no mailbox", async () => {
  kit.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
  expect(
    await as(people.manager).getOutsideInviting({
      data: { event: null },
    }),
  ).toBe("mailOff");
  expect(
    await refused(
      as(people.manager).createEvent({
        data: {
          calendarId: TEAM,
          draft: planning({ people: [outside(OUTSIDE)] }),
        },
      }),
    ),
  ).toEqual({
    status: 403,
    message:
      "Mail is off, so people outside your organisation can't be invited. Invite colleagues only, or ask your admin to turn Mail back on.",
  });
  // Colleagues can still be invited, and get their copy.
  await invite([people.colleague]);
  expect(await notSent()).toEqual({
    "Jo Okafor": { kind: "refused", reason: "mailOff" },
  });
  kit.sqlite.run("DELETE FROM app_settings");

  kit.sqlite.run("DELETE FROM mailbox_access WHERE user_id = ?", [
    people.editor,
  ]);
  expect(
    await as(people.editor).getOutsideInviting({
      data: { event: null },
    }),
  ).toBe("noSender");
  expect(
    await refused(
      as(people.editor).createEvent({
        data: {
          calendarId: TEAM,
          draft: planning({ people: [outside(OUTSIDE)] }),
        },
      }),
    ),
  ).toMatchObject({ status: 403 });
  expect(
    // The validator refuses before the handler runs, as the request arrives.
    await refused(
      Promise.resolve().then(() =>
        as(people.manager).createEvent({
          data: {
            calendarId: TEAM,
            draft: planning({ people: [{ email: "dana@" as EmailAddress }] }),
          },
        }),
      ),
    ),
  ).toEqual({
    status: 400,
    message:
      "One of the email addresses isn't complete. Check it, such as name@example.com.",
  });
});

test("an address already invited stays when Mail is off, and the event can still change", async () => {
  const uid = await invite([outside(OUTSIDE)]);
  kit.sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
  await change(uid, { title: "Planning, moved", people: [outside(OUTSIDE)] });
  expect((await organisersView()).title).toBe("Planning, moved");
  expect(await notSent()).toEqual({
    [OUTSIDE]: { kind: "refused", reason: "mailOff" },
  });
});

test("an all-day event is written as dates", async () => {
  const uid = await invite([outside(OUTSIDE)], {
    time: {
      kind: "allDay",
      startDate: "2026-12-24" as CivilDate,
      endDate: "2026-12-27" as CivilDate,
    },
  });
  const { read, ics, events } = invitationIn(email.sent[0]!);
  expect(read.subject).toBe(
    "Invitation: Weekly planning, Thu 24 Dec to Sat 26 Dec, all day",
  );
  expect(ics).toContain("DTSTART;VALUE=DATE:20261224");
  expect(ics).not.toContain("VTIMEZONE");
  expect(events[0]).toMatchObject({
    uid,
    time: { kind: "allDay", startDate: "2026-12-24", endDate: "2026-12-27" },
  });
});

test("a repeat keeps its zone, its removed dates, and its changed dates", async () => {
  const uid = await invite([outside(OUTSIDE)], { repeat: WEEKLY });
  // One date moves an hour later, and the third is called off.
  await as(people.manager).updateEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: SECOND },
      scope: "this",
      draft: planning({
        title: "Planning, later",
        people: [outside(OUTSIDE)],
        repeat: WEEKLY,
        time: timed("2026-11-17T11:00:00+11:00", "2026-11-17T12:00:00+11:00"),
      }),
    },
  });
  await as(people.manager).deleteEvent({
    data: {
      calendarId: TEAM,
      target: { uid, occurrenceId: "20261123T230000Z" as OccurrenceId },
      scope: "this",
    },
  });
  await objects.settle();
  const latest = sentTo(OUTSIDE).at(-1)!;
  const { ics, events } = invitationIn(latest);
  expect(ics).toContain("BEGIN:VTIMEZONE\r\nTZID:Australia/Sydney");
  expect(ics).toContain("DTSTART;TZID=Australia/Sydney:20261110T100000");
  expect(ics).toContain("RRULE:FREQ=WEEKLY");
  expect(ics).toContain("EXDATE;TZID=Australia/Sydney:20261124T100000");
  expect(ics).toContain("RECURRENCE-ID;TZID=Australia/Sydney:20261117T100000");
  const [series, moved] = events;
  expect(series).toMatchObject({
    uid,
    recurrenceId: null,
    rule: "FREQ=WEEKLY",
    exdates: ["20261123T230000Z"],
    time: TUESDAY,
  });
  expect(moved).toMatchObject({
    uid,
    recurrenceId: SECOND,
    title: "Planning, later",
    time: timed("2026-11-17T11:00:00+11:00", "2026-11-17T12:00:00+11:00"),
  });
  // Each change took a sequence above any the event held.
  expect(series!.sequence).toBeGreaterThan(moved!.sequence);
  expect(readEmail(latest.raw).subject).toStartWith("Updated invitation:");
});

test("a colleague with no mailbox gets their copy and no email", async () => {
  kit.sqlite.run("DELETE FROM mailbox_access WHERE user_id = ?", [
    people.colleague,
  ]);
  await invite([people.colleague]);
  expect(email.attempts).toEqual([]);
  expect(await notSent()).toEqual({});
  expect(objects.alarmOf(TEAM)).toBeNull();
});

test("an event takes a hundred colleagues besides its organiser, and a team takes a hundred at once", async () => {
  const many = Array.from({ length: 100 }, (_, index) => {
    const id = `person-${index}` as UserId;
    kit.sqlite.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
      id,
      `Person ${index}`,
      `person${index}@example.com`,
    ]);
    return id;
  });
  const uid = await invite(many);
  const shown = await organisersView();
  expect(shown.organiser).toMatchObject({ userId: people.manager });
  expect(shown.people).toHaveLength(100);
  await change(uid, { title: "Planning, moved", people: many });
  expect((await organisersView()).people).toHaveLength(100);

  await as(people.manager).addMembers({
    data: { calendarId: TEAM, people: many, role: "viewer" },
  });
  expect(
    await as(people.manager).getMembers({ data: { calendarId: TEAM } }),
  ).toHaveLength(103);
});

test("deleting a team calendar sends everyone invited one cancellation", async () => {
  const uid = await invite([people.colleague, outside(OUTSIDE)]);
  await as(people.manager).deleteTeamCalendar({ data: { calendarId: TEAM } });
  await objects.settle();
  for (const address of [OUTSIDE, "jo@example.com"]) {
    const [, cancellation, ...more] = sentTo(address);
    expect(more).toEqual([]);
    const cancelled = invitationIn(cancellation!);
    expect(cancelled.read.subject).toStartWith("Cancelled: Weekly planning");
    expect(cancelled.events[0]).toMatchObject({ uid, cancelled: true });
  }
  expect(objects.alarmOf(TEAM)).toBeNull();
});

test("deleting a team calendar sends nothing from a suspended organiser's address", async () => {
  await invite([outside(OUTSIDE)], {}, people.editor);
  kit.sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [people.editor]);
  await as(people.manager).deleteTeamCalendar({ data: { calendarId: TEAM } });
  await objects.settle();
  expect(sentTo(OUTSIDE)).toHaveLength(1);
});

const teamInD1 = () =>
  kit.rows(`SELECT id FROM calendars WHERE id = '${TEAM}'`).length > 0;

const eventsLeft = () => objects.sqlite().query("SELECT uid FROM events").all();

const cancellationsTo = (address: string) =>
  sentTo(address).filter((one) =>
    readEmail(one.raw).subject.startsWith("Cancelled:"),
  );

const deleteTeam = () =>
  as(people.manager).deleteTeamCalendar({ data: { calendarId: TEAM } });

// As if the call to the calendar's object failed before it did anything, or after.
function failErase(fault: "silent" | "loseAnswer" | null) {
  const real = objects.env.CALENDAR;
  env.CALENDAR =
    fault === null
      ? real
      : {
          idFromName: real.idFromName,
          get: (id: DurableObjectId) =>
            new Proxy(real.get(id), {
              get(target, property) {
                const value = Reflect.get(target, property);
                if (property !== "erase") return value;
                return async (...args: unknown[]) => {
                  if (fault === "silent") throw new Error("Calendar is silent");
                  await value(...args);
                  throw new Error("Calendar's answer was lost");
                };
              },
            }),
        };
}

for (const fault of ["silent", "loseAnswer"] as const) {
  test(`a delete whose calendar object fails (${fault}) leaves the calendar listed, and deleting again sends each cancellation once`, async () => {
    await invite([people.colleague, outside(OUTSIDE)]);
    failErase(fault);
    await expect(deleteTeam()).rejects.toThrow();
    expect(teamInD1()).toBe(true);

    failErase(null);
    await deleteTeam();
    await objects.settle();
    expect(teamInD1()).toBe(false);
    expect(eventsLeft()).toEqual([]);
    for (const address of [OUTSIDE, "jo@example.com"]) {
      expect(cancellationsTo(address)).toHaveLength(1);
    }
    expect(objects.alarmOf(TEAM)).toBeNull();
  });
}

test("a delete whose D1 step fails leaves a calendar that refuses every change, sends its cancellations, and deleting again finishes it", async () => {
  const uid = await invite([people.colleague, outside(OUTSIDE)]);
  kit.sqlite.run(
    `CREATE TRIGGER d1_fails BEFORE DELETE ON calendars
     BEGIN SELECT RAISE(ABORT, 'D1 is unreachable'); END`,
  );
  await expect(deleteTeam()).rejects.toThrow();
  expect(teamInD1()).toBe(true);
  await objects.settle();
  for (const address of [OUTSIDE, "jo@example.com"]) {
    expect(cancellationsTo(address)).toHaveLength(1);
  }

  // As from a page still open from before the delete.
  const gone = { status: 404, message: CALENDAR_GONE_MESSAGE };
  expect(
    await refused(
      as(people.editor).createEvent({
        data: { calendarId: TEAM, draft: planning() },
      }),
    ),
  ).toEqual(gone);
  expect(
    await refused(
      as(people.editor).importCalendarFile({
        data: { calendarId: TEAM, file: GOOGLE_EXPORT, timeZone: SYDNEY },
      }),
    ),
  ).toEqual(gone);
  const target = { uid, occurrenceId: null };
  expect(
    await refused(
      as(people.editor).updateEvent({
        data: { calendarId: TEAM, target, scope: "all", draft: planning() },
      }),
    ),
  ).toEqual(gone);
  expect(
    await refused(
      as(people.editor).deleteEvent({
        data: { calendarId: TEAM, target, scope: "all" },
      }),
    ),
  ).toEqual(gone);
  expect(eventsLeft()).toEqual([]);

  kit.sqlite.run("DROP TRIGGER d1_fails");
  await deleteTeam();
  await objects.settle();
  expect(teamInD1()).toBe(false);
  for (const address of [OUTSIDE, "jo@example.com"]) {
    expect(cancellationsTo(address)).toHaveLength(1);
  }
  expect(objects.alarmOf(TEAM)).toBeNull();
});

test("nothing in a title, place or notes can add a line to the invitation", async () => {
  await invite([outside(OUTSIDE)], {
    title: "Budget\rATTENDEE:mailto:injected@evil.example",
    location: "Room 4\u2028ORGANIZER:mailto:ceo@example.com",
    notes:
      "x\rORGANIZER:mailto:ceo@example.com\u0085ATTENDEE:mailto:two@evil.example",
  });
  const { ics, events } = invitationIn(email.sent[0]!);
  expect(ics).not.toMatch(/\r(?!\n)/);
  // As a reader that breaks lines at any of these would see it.
  const lines = ics
    .replace(/\r\n[ \t]/g, "")
    .split(/\r\n|[\r\n\u0085\u2028\u2029]/);
  expect(lines.filter((line) => line.startsWith("ATTENDEE"))).toHaveLength(1);
  expect(lines.filter((line) => line.startsWith("ORGANIZER"))).toEqual([
    "ORGANIZER;CN=Boss:mailto:boss@example.com",
  ]);
  expect(events[0]?.attendees).toHaveLength(1);
});

test("calling off one date sends a cancellation for that date alone", async () => {
  const uid = await invite([people.colleague, outside(OUTSIDE)], {
    repeat: WEEKLY,
  });
  const remove = (occurrenceId: OccurrenceId) =>
    as(people.manager).deleteEvent({
      data: { calendarId: TEAM, target: { uid, occurrenceId }, scope: "this" },
    });
  await remove(SECOND);
  await objects.settle();
  for (const address of [OUTSIDE, "jo@example.com"]) {
    const [, off, ...more] = sentTo(address);
    expect(more).toEqual([]);
    const cancelled = invitationIn(off!);
    expect(cancelled.read.subject).toBe(
      "Cancelled: Weekly planning, Tue 17 Nov, 10:00 to 11:00 (Australia/Sydney)",
    );
    expect(cancelled.calendar.headers.get("content-type")).toBe(
      "text/calendar; charset=UTF-8; method=CANCEL",
    );
    expect(cancelled.ics).toContain(
      "RECURRENCE-ID;TZID=Australia/Sydney:20261117T100000",
    );
    expect(cancelled.ics).not.toContain("RRULE:FREQ=WEEKLY");
    expect(cancelled.events).toHaveLength(1);
    expect(cancelled.events[0]).toMatchObject({
      uid,
      recurrenceId: SECOND,
      cancelled: true,
      sequence: 1,
    });
  }

  // The next email is an update to the event they still have, without that date.
  await change(uid, {
    title: "Planning, renamed",
    repeat: WEEKLY,
    people: [people.colleague, outside(OUTSIDE)],
  });
  const update = invitationIn(sentTo(OUTSIDE)[2]!);
  expect(update.read.subject).toStartWith(
    "Updated invitation: Planning, renamed",
  );
  expect(update.events[0]).toMatchObject({ uid, exdates: [SECOND] });

  // Two dates called off before anything goes make one update without either.
  const third = "20261123T230000Z" as OccurrenceId;
  const fourth = "20261130T230000Z" as OccurrenceId;
  await remove(third);
  await remove(fourth);
  await objects.settle();
  const [last, ...after] = sentTo(OUTSIDE).slice(3);
  expect(after).toEqual([]);
  const both = invitationIn(last!);
  expect(both.read.subject).toStartWith("Updated invitation:");
  expect(both.events[0]).toMatchObject({
    uid,
    exdates: [SECOND, third, fourth],
  });
});

test("only the person, or someone who can edit the event, learns whether emails can go from an organiser", async () => {
  const uid = await invite([]);
  const about = { calendarId: TEAM, uid };
  expect(
    await as(people.editor).getOutsideInviting({ data: { event: about } }),
  ).toBe("ready");
  expect(
    await refused(
      as(people.viewer).getOutsideInviting({ data: { event: about } }),
    ),
  ).toMatchObject({ status: 403 });
  expect(
    await refused(
      as(people.colleague).getOutsideInviting({ data: { event: about } }),
    ),
  ).toEqual({
    status: 403,
    message:
      "You don't have access to this calendar. Ask one of its managers if you need it.",
  });
  kit.sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [people.manager]);
  expect(
    await as(people.editor).getOutsideInviting({ data: { event: about } }),
  ).toBe("noSender");
  kit.sqlite.run("DELETE FROM mailbox_access WHERE user_id = ?", [
    people.colleague,
  ]);
  expect(
    await as(people.colleague).getOutsideInviting({ data: { event: null } }),
  ).toBe("noSender");
  // Anyone else, named by their id, isn't something to ask about.
  expect(
    await refused(
      Promise.resolve().then(() =>
        as(people.colleague).getOutsideInviting({
          data: { organiser: people.editor } as never,
        }),
      ),
    ),
  ).toMatchObject({ status: 400 });
});

test("a colleague's own address, or their alias, invites them as a colleague", async () => {
  const { mailbox_id } = kit.sqlite
    .query("SELECT mailbox_id FROM addresses WHERE address = 'jo@example.com'")
    .get() as { mailbox_id: string };
  kit.sqlite.run(
    "INSERT INTO addresses (address, domain, mailbox_id, kind) VALUES ('jo.okafor@example.com', 'example.com', ?, 'alias')",
    [mailbox_id],
  );
  await invite([
    outside("Jo@Example.com"),
    outside("jo.okafor@example.com"),
    people.colleague,
  ]);
  expect((await organisersView()).people).toEqual([
    expect.objectContaining({ kind: "colleague", userId: people.colleague }),
  ]);
  expect(email.sent.map((one) => one.to)).toEqual(["jo@example.com"]);
  expect(
    await as(people.colleague).listInvitations({
      data: { timeZone: SYDNEY },
    }),
  ).toHaveLength(1);
});

test("one email that can't be read doesn't hold up the others", async () => {
  await as(people.manager).createEvent({
    data: {
      calendarId: TEAM,
      draft: planning({
        people: [outside(OUTSIDE), outside("late@partner.example.org")],
      }),
    },
  });
  objects
    .sqlite(TEAM)
    .run(
      "UPDATE invitation_emails SET cancelled_date = 'not a date', try_at = try_at - 1 WHERE recipient = ?",
      [`mailto:${OUTSIDE}`],
    );
  await objects.settle();
  expect(email.sent.map((one) => one.to)).toEqual(["late@partner.example.org"]);
  expect(await notSent()).toEqual({
    [OUTSIDE]: { kind: "refused", reason: "checkUnavailable" },
  });
  expect(objects.alarmOf(TEAM)).toBeNull();
});

test("an event that ends in the next year says that year", async () => {
  await invite([outside(OUTSIDE)], {
    time: timed("2026-12-31T23:00:00+11:00", "2027-01-01T01:00:00+11:00"),
  });
  expect(readEmail(email.sent[0]!.raw).subject).toBe(
    "Invitation: Weekly planning, Thu 31 Dec, 23:00 to Fri, 1 Jan 2027, 01:00 (Australia/Sydney)",
  );
});
