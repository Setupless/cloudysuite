import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { partOfType, readEmail } from "@cloudysuite/app-email/test-support";
import {
  ALICE,
  BOB,
  CAROL,
  create,
  createBoardTest,
  date,
  MARKETING,
  newTaskId,
} from "./test-support";
import type { NotEmailedReason, Person } from "./types";

const START = Date.UTC(2026, 10, 12, 9, 0, 0);
const WAIT = 10_000;

beforeEach(() => setSystemTime(START));
afterEach(() => setSystemTime());

const addressOf = (person: Person) => `${person.id.slice(5)}@example.com`;

// Alice manages Marketing, and Bob and Carol can edit it. Everyone has a personal
// mailbox, and the app domain is a parent of the email domain.
function setUp() {
  const kit = createBoardTest();
  kit.directory.run(
    "INSERT INTO domains (name, is_primary) VALUES ('suite.example.com', 1), ('example.com', 0)",
  );
  for (const person of [ALICE, BOB, CAROL]) {
    const mailbox = `mailbox-${person.id}`;
    kit.directory.run(
      "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'personal', ?)",
      [mailbox, person.name],
    );
    kit.directory.run(
      "INSERT INTO addresses (address, domain, mailbox_id, kind) VALUES (?, 'example.com', ?, 'primary')",
      [addressOf(person), mailbox],
    );
    kit.directory.run(
      "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'manager')",
      [mailbox, person.id],
    );
  }
  kit.join(BOB, "editor");
  kit.join(CAROL, "editor");
  // Runs the board's alarm at a given moment, as the runtime would once it's due.
  const at = async (ms: number) => {
    setSystemTime(START + ms);
    const due = kit.alarmOf(MARKETING);
    if (due !== null && due <= Date.now()) await kit.runAlarm(MARKETING);
  };
  return { ...kit, at };
}

async function assignedTask(
  kit: ReturnType<typeof setUp>,
  assignee: Person | null,
  by: Person = ALICE,
  title = "Send the newsletter",
) {
  const id = newTaskId();
  const board = await kit.as(by);
  await board.change(create(id, { title, assignee, due: date("2026-11-17") }));
  return { id, board };
}

test("assigning someone else queues one email, which goes after 10 seconds", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, null);
  await board.change({ kind: "assign", id, assignee: BOB });

  expect(await board.assignmentEmail(id)).toEqual({ state: "pending" });
  expect(kit.alarmOf(MARKETING)).toBe(START + WAIT);
  await kit.runAlarm(MARKETING);
  expect(kit.email.attempts).toEqual([]);

  await kit.at(WAIT);
  expect(kit.email.sent).toHaveLength(1);
  const [sent] = kit.email.sent;
  expect(sent!.from).toBe(addressOf(ALICE));
  expect(sent!.to).toBe(addressOf(BOB));
  const message = readEmail(sent!.raw);
  expect(message.subject).toBe("Alice Stone assigned you a task");
  expect(message.headers.get("from")).toBe(
    `"Alice Stone" <${addressOf(ALICE)}>`,
  );
  const text = partOfType(message, "text/plain").body;
  expect(text).toContain("Task: Send the newsletter");
  expect(text).toContain("Board: Marketing");
  expect(text).toContain("Due: Tuesday 17 November");
  expect(await board.assignmentEmail(id)).toEqual({ state: "sent" });

  await kit.at(10 * 60_000);
  expect(kit.email.attempts).toHaveLength(1);
});

test("a new task that names someone else emails them", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  await kit.at(WAIT);
  expect(kit.email.sent.map((one) => one.to)).toEqual([addressOf(BOB)]);
  expect(await board.assignmentEmail(id)).toEqual({ state: "sent" });
});

test("assigning yourself queues nothing", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, null);
  await board.change({ kind: "assign", id, assignee: ALICE });
  await assignedTask(kit, BOB, BOB);

  expect(await board.assignmentEmail(id)).toEqual({ state: "none" });
  expect(kit.alarmOf(MARKETING)).toBeNull();
  await kit.at(WAIT);
  expect(kit.email.attempts).toEqual([]);
});

test("reassigning within 10 seconds sends nothing to the first person", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  setSystemTime(START + 5_000);
  await board.change({ kind: "assign", id, assignee: CAROL });

  await kit.at(WAIT);
  expect(kit.email.attempts).toEqual([]);
  await kit.at(5_000 + WAIT);
  expect(kit.email.sent.map((one) => one.to)).toEqual([addressOf(CAROL)]);
});

test("taking the assignee off within 10 seconds sends nothing", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  await board.change({ kind: "assign", id, assignee: null });
  await kit.at(WAIT);
  expect(kit.email.attempts).toEqual([]);
  expect(await board.assignmentEmail(id)).toEqual({ state: "none" });
});

const FAILED_CHECKS: [
  string,
  (kit: ReturnType<typeof setUp>) => void,
  NotEmailedReason,
][] = [
  [
    "Tasks is off",
    (kit) =>
      kit.directory.run(
        "INSERT INTO app_settings (app, enabled) VALUES ('tasks', 0)",
      ),
    "tasksOff",
  ],
  [
    "Mail is off",
    (kit) =>
      kit.directory.run(
        "INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)",
      ),
    "mailOff",
  ],
  [
    "the assignee left the board",
    (kit) =>
      kit.directory.run("DELETE FROM board_access WHERE user_id = ?", [BOB.id]),
    "assigneeCantOpen",
  ],
  [
    "the assignee was suspended",
    (kit) =>
      kit.directory.run("UPDATE user SET banned = 1 WHERE id = ?", [BOB.id]),
    "assigneeCantOpen",
  ],
  [
    "the assigner can only view the board now",
    (kit) =>
      kit.directory.run(
        "UPDATE board_access SET role = 'viewer' WHERE user_id = ?",
        [CAROL.id],
      ),
    "assignerCantEdit",
  ],
  [
    "the assigner has no personal mailbox",
    (kit) =>
      kit.directory.run("DELETE FROM mailbox_access WHERE user_id = ?", [
        CAROL.id,
      ]),
    "noSender",
  ],
  [
    "the assignee has no personal mailbox",
    (kit) =>
      kit.directory.run("DELETE FROM mailbox_access WHERE user_id = ?", [
        BOB.id,
      ]),
    "noAddress",
  ],
];

for (const [what, change, reason] of FAILED_CHECKS) {
  test(`nothing goes when ${what}, and the panel says why`, async () => {
    const kit = setUp();
    const { id, board } = await assignedTask(kit, BOB, CAROL);
    change(kit);
    await kit.at(WAIT);
    expect(kit.email.attempts).toEqual([]);
    expect(await (await kit.as(ALICE)).assignmentEmail(id)).toEqual({
      state: "notSent",
      reason,
    });
    expect((await board.findTask(id))?.assignee).toEqual(BOB);
  });
}

test("a task deleted before its email goes sends nothing", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  setSystemTime(START + 5_000);
  await board.change({ kind: "delete", id });
  await kit.at(WAIT);
  await kit.at(5_000 + WAIT);
  expect(kit.email.attempts).toEqual([]);
  expect(kit.alarmOf(MARKETING)).toBeNull();
});

test("a task brought back with Undo still emails its assignee", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  setSystemTime(START + 5_000);
  await board.change({ kind: "delete", id });
  await kit.at(WAIT);
  setSystemTime(START + 12_000);
  await board.change({ kind: "undoDelete", id });
  await kit.at(5_000 + WAIT);
  expect(kit.email.sent.map((one) => one.to)).toEqual([addressOf(BOB)]);
});

test("a rate limit tries again by itself", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  kit.email.willEnd({ kind: "refused", code: "E_RATE_LIMIT_EXCEEDED" });
  await kit.at(WAIT);
  expect(kit.email.sent).toEqual([]);
  expect(await board.assignmentEmail(id)).toEqual({ state: "pending" });

  await kit.at(WAIT + 30_000);
  expect(kit.email.sent).toHaveLength(1);
  expect(await board.assignmentEmail(id)).toEqual({ state: "sent" });
});

test("a rate limit that doesn't clear gives up and says so", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  const limited = { kind: "refused", code: "E_RATE_LIMIT_EXCEEDED" } as const;
  kit.email.willEnd(limited, limited, limited, limited);
  for (const ms of [WAIT, WAIT + 30_000, WAIT + 150_000, WAIT + 750_000]) {
    await kit.at(ms);
  }
  expect(kit.email.attempts).toHaveLength(4);
  expect(await board.assignmentEmail(id)).toEqual({
    state: "notSent",
    reason: "rateLimited",
  });
});

test("a refusal from the service doesn't try again", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  kit.email.willEnd({ kind: "refused", code: "E_RECIPIENT_SUPPRESSED" });
  await kit.at(WAIT);
  await kit.at(60 * 60_000);
  expect(kit.email.attempts).toHaveLength(1);
  expect(await board.assignmentEmail(id)).toEqual({
    state: "notSent",
    reason: "recipientSuppressed",
  });
});

test("an email that may have gone is never sent again by itself", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  kit.email.willEnd({ kind: "unclear" });
  await kit.at(WAIT);
  await kit.at(60 * 60_000);
  expect(kit.email.attempts).toHaveLength(1);
  expect(await board.assignmentEmail(id)).toEqual({ state: "unclear" });
});

test("Try again sends once, however often it's chosen", async () => {
  const kit = setUp();
  kit.directory.run(
    "INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)",
  );
  const { id, board } = await assignedTask(kit, BOB);
  await kit.at(WAIT);
  kit.directory.run("DELETE FROM app_settings");

  const carol = await kit.as(CAROL);
  setSystemTime(START + 20_000);
  await carol.retryAssignmentEmail(id);
  await carol.retryAssignmentEmail(id);
  await board.retryAssignmentEmail(id);
  await kit.at(20_000);
  await board.retryAssignmentEmail(id);
  await kit.at(60 * 60_000);

  expect(kit.email.sent).toHaveLength(1);
  // It goes from whoever chose Try again.
  expect(kit.email.sent[0]!.from).toBe(addressOf(CAROL));
  expect(await board.assignmentEmail(id)).toEqual({ state: "sent" });
});

test("Try again never emails someone about their own task", async () => {
  const kit = setUp();
  kit.directory.run(
    "INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)",
  );
  const { id } = await assignedTask(kit, BOB);
  await kit.at(WAIT);
  kit.directory.run("DELETE FROM app_settings");
  await (await kit.as(BOB)).retryAssignmentEmail(id);
  await kit.at(60_000);
  expect(kit.email.attempts).toEqual([]);
});

test("Can view can't choose Try again", async () => {
  const kit = setUp();
  kit.directory.run(
    "INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)",
  );
  const { id } = await assignedTask(kit, BOB);
  await kit.at(WAIT);
  kit.directory.run("DELETE FROM app_settings");
  kit.directory.run(
    "UPDATE board_access SET role = 'viewer' WHERE user_id = ?",
    [CAROL.id],
  );
  expect(await (await kit.as(CAROL)).retryAssignmentEmail(id)).toBe("noAccess");
});

test("an attempt that never finished is never sent again by itself", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, BOB);
  // The send hangs past its claim, as if the object stopped while it was out.
  let release: () => void = () => {};
  kit.env.EMAIL.send = (() =>
    new Promise<never>((_, reject) => {
      release = () => reject(new Error("The object stopped"));
    })) as typeof kit.env.EMAIL.send;
  setSystemTime(START + WAIT);
  const running = kit.runAlarm(MARKETING);
  await Bun.sleep(0);
  // Its claim is found still sending on the next wake-up.
  setSystemTime(START + WAIT + 61_000);
  await kit.objectOf(MARKETING).alarm();
  expect(await board.assignmentEmail(id)).toEqual({ state: "unclear" });
  release();
  await running;
  expect(await board.assignmentEmail(id)).toEqual({ state: "unclear" });
});

test("the HTML holds the title and board as text, never markup", async () => {
  const kit = setUp();
  kit.directory.run("UPDATE boards SET name = ? WHERE id = ?", [
    "<b>Marketing</b>",
    MARKETING,
  ]);
  await assignedTask(kit, BOB, ALICE, `<img src=x onerror="alert(1)">`);
  await kit.at(WAIT);
  const html = partOfType(readEmail(kit.email.sent[0]!.raw), "text/html").body;
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(html).toContain("&lt;b&gt;Marketing&lt;/b&gt;");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
});

test("the notes stay out of the email", async () => {
  const kit = setUp();
  const { id, board } = await assignedTask(kit, null);
  await board.change({ kind: "setNotes", id, notes: "The budget is 40k" });
  await board.change({ kind: "assign", id, assignee: BOB });
  await kit.at(WAIT);
  expect(
    readEmail(kit.email.sent[0]!.raw)
      .parts.map((one) => one.body)
      .join(""),
  ).not.toContain("budget");
});

test("Open task links to the task's panel on the stored app domain", async () => {
  const kit = setUp();
  const { id } = await assignedTask(kit, BOB);
  await kit.at(WAIT);
  const message = readEmail(kit.email.sent[0]!.raw);
  const link = `https://tasks.suite.example.com/boards/${MARKETING}?task=${id}`;
  expect(partOfType(message, "text/plain").body).toContain(
    `Open task: ${link}`,
  );
  expect(partOfType(message, "text/html").body).toContain(
    `<a href="${link}">Open task</a>`,
  );
});
