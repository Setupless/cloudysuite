import { beforeEach, expect, test } from "bun:test";
import {
  checkMailboxAccess,
  type MailboxGrant,
  type UserId,
} from "@cloudysuite/access";
import type { MailboxRole } from "../../../../src/db/schema";
import { createTestDatabase } from "../../../../src/db/test-database";
import { openMailbox, openMailboxRuleEditor } from "../client";
import { ingest } from "../ingest";
import { LabelStore } from "../labels/store";
import { applyMigrations } from "../migrations";
import { placementFor } from "../placement";
import type { SqlDriver } from "../sql";
import { MailboxStore } from "../store";
import {
  createSqlDriver,
  createTestEnv,
  eml,
  MAILBOX_A,
} from "../test-support";
import type { LabelId, NewMessage, ThreadId } from "../types";
import { applyRules, factsOf } from "./evaluate";
import { RuleStore } from "./store";
import {
  MAX_CONDITION_LENGTH,
  MAX_CONDITIONS,
  MAX_RULES,
  parseRuleDraft,
  type Rule,
  type RuleCondition,
  type RuleDraft,
  type RuleId,
} from "./types";

let db: SqlDriver;
let store: MailboxStore;
let rules: RuleStore;
let labels: LabelStore;
let serial = 0;

beforeEach(() => {
  ({ db } = createSqlDriver());
  applyMigrations(db);
  store = new MailboxStore(db);
  rules = new RuleStore(db);
  labels = new LabelStore(db, rules);
});

function message(overrides: Partial<NewMessage> = {}): NewMessage {
  serial += 1;
  return {
    rawHash: `hash-${serial}`,
    rawSize: 10,
    r2Prefix: `p/${serial}/`,
    source: "inbound",
    envelopeFrom: "boss@example.org",
    envelopeTo: "sales@example.com",
    parseStatus: "parsed",
    rfcMessageId: `id-${serial}@x`,
    references: [],
    subject: "Quarterly Numbers",
    from: { name: "The Boss", address: "boss@example.org" },
    replyTo: [],
    to: [{ name: "Sales", address: "sales@example.com" }],
    cc: [{ name: "Finance", address: "finance@example.com" }],
    snippet: "snippet",
    sentAt: serial,
    receivedAt: serial,
    authResults: null,
    searchBody: "Please read the attached REPORT today.",
    bodies: [],
    attachments: [],
    ...overrides,
  };
}

const NO_ACTIONS = { move: null, labelId: null, markRead: false, star: false };
const draft = (overrides: Partial<RuleDraft> = {}): RuleDraft => ({
  name: "A rule",
  enabled: true,
  match: "all",
  conditions: [{ kind: "contains", field: "from", text: "boss" }],
  actions: { ...NO_ACTIONS, star: true },
  ...overrides,
});
const contains = (
  field: "from" | "to" | "cc" | "subject" | "body",
  text: string,
): RuleCondition => ({ kind: "contains", field, text });

const label = (name = "Work"): LabelId => {
  const write = labels.create(name, "accent");
  if (!write.ok) throw new Error(write.message);
  return write.label.id;
};
const add = (overrides: Partial<RuleDraft> = {}) => {
  const write = rules.create(draft(overrides));
  if (!write.ok) throw new Error(write.message);
  return write.rule;
};
const stored = (input: NewMessage) => {
  const { threadId } = store.commit(input);
  return store.getThread(threadId)!.messages.at(-1)!;
};

test("each condition reads its own part of the message, ignoring case", () => {
  const facts = factsOf(message());
  const matches = (condition: RuleCondition) =>
    applyRules(
      [{ ...draft({ conditions: [condition] }), id: 1 as RuleId }],
      facts,
    ).starred;
  expect(matches(contains("from", "THE BOSS"))).toBe(true);
  expect(matches(contains("from", "sales"))).toBe(false);
  expect(matches(contains("to", "sales@example.com"))).toBe(true);
  expect(matches(contains("cc", "finance"))).toBe(true);
  expect(matches(contains("cc", "sales"))).toBe(false);
  expect(matches(contains("subject", "quarterly n"))).toBe(true);
  expect(matches(contains("subject", "report"))).toBe(false);
  expect(matches(contains("body", "attached report"))).toBe(true);
  expect(matches({ kind: "hasAttachment" })).toBe(false);
  expect(matches({ kind: "sentToAlias", address: "sales@example.com" })).toBe(
    true,
  );
  expect(matches({ kind: "sentToAlias", address: "other@example.com" })).toBe(
    false,
  );
});

test("a plus address counts as its base address", () => {
  const facts = factsOf(message({ envelopeTo: "Sales+ads@Example.com" }));
  expect(
    applyRules(
      [
        {
          ...draft({
            conditions: [{ kind: "sentToAlias", address: "sales@example.com" }],
          }),
          id: 1 as RuleId,
        },
      ],
      facts,
    ).starred,
  ).toBe(true);
});

test("an inline image is not a file attached", () => {
  const withFile = (inline: boolean) =>
    factsOf(
      message({
        attachments: [
          {
            position: 0,
            filename: "x",
            mimeType: "image/png",
            inline,
            contentId: null,
            size: 1,
            r2Key: "k",
          },
        ],
      }),
    ).hasAttachment;
  expect(withFile(true)).toBe(false);
  expect(withFile(false)).toBe(true);
});

test("all needs every condition and any needs one", () => {
  const conditions = [contains("from", "boss"), contains("subject", "nope")];
  add({ match: "all", conditions, actions: { ...NO_ACTIONS, star: true } });
  add({ match: "any", conditions, actions: { ...NO_ACTIONS, markRead: true } });
  expect(stored(message())).toMatchObject({ starred: false, read: true });
});

test("each action happens, and the message arrives as the rule said", () => {
  const work = label();
  add({
    actions: { move: "archive", labelId: work, markRead: true, star: true },
  });
  const arrived = stored(message());
  expect(arrived).toMatchObject({
    folder: "archive",
    read: true,
    starred: true,
    labelIds: [work],
  });
  const rows = store.listThreads({ view: { labelId: work } }).threads;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ starred: true, unreadCount: 0 });
  expect(store.listThreads({ view: { folder: "inbox" } }).threads).toEqual([]);
});

test("every rule that matches applies, and the highest move wins", () => {
  const first = label("First");
  const second = label("Second");
  add({ actions: { ...NO_ACTIONS, move: "archive", labelId: first } });
  add({ actions: { ...NO_ACTIONS, move: "trash", labelId: second } });
  const arrived = stored(message());
  expect(arrived.folder).toBe("archive");
  expect(arrived.labelIds.toSorted()).toEqual([first, second].toSorted());
});

test("reordering changes which move wins", () => {
  const archive = add({ actions: { ...NO_ACTIONS, move: "archive" } });
  const trash = add({ actions: { ...NO_ACTIONS, move: "trash" } });
  expect(rules.reorder([trash.id, archive.id])).toBe(true);
  expect(stored(message()).folder).toBe("trash");
  expect(rules.list().map((rule) => rule.id)).toEqual([trash.id, archive.id]);
});

test("an out-of-date order changes nothing", () => {
  const one = add();
  const two = add();
  expect(rules.reorder([two.id])).toBe(false);
  expect(rules.reorder([two.id, two.id])).toBe(false);
  expect(rules.reorder([one.id, 99 as RuleId])).toBe(false);
  expect(rules.list().map((rule) => rule.id)).toEqual([one.id, two.id]);
});

test("an unreadable stored rule neither blocks a reorder nor counts toward the limit", () => {
  const broken = add();
  const one = add();
  const two = add();
  db.exec("UPDATE rules SET conditions = 'not json' WHERE id = ?", broken.id);
  expect(rules.list().map((rule) => rule.id)).toEqual([one.id, two.id]);
  expect(rules.reorder([two.id, one.id])).toBe(true);
  expect(rules.list().map((rule) => rule.id)).toEqual([two.id, one.id]);
  expect(rules.reorder([two.id, one.id, broken.id])).toBe(false);
  for (let index = 0; index < MAX_RULES - 2; index += 1) add();
  expect(rules.create(draft())).toMatchObject({ ok: false, status: 409 });
  expect(
    db.exec("SELECT id FROM rules WHERE id = ?", broken.id).toArray(),
  ).toHaveLength(1);
});

test("a rule that is off does nothing", () => {
  add({ enabled: false });
  expect(stored(message()).starred).toBe(false);
});

test("imported and sent mail are never touched", () => {
  add({ actions: { ...NO_ACTIONS, move: "trash", star: true } });
  expect(stored(message({ source: "import" }))).toMatchObject({
    folder: "archive",
    starred: false,
  });
  expect(stored(message({ source: "sent" }))).toMatchObject({
    folder: "sent",
    starred: false,
  });
});

test("a repeat delivery does not run rules again", () => {
  const work = label();
  add({ actions: { ...NO_ACTIONS, star: true, labelId: work } });
  const input = message();
  const first = store.commit(input);
  store.setFlags({ messageIds: [first.messageId] }, { starred: false });
  store.setLabel({ messageIds: [first.messageId] }, work, false);

  expect(store.commit(input).status).toBe("duplicate");
  expect(store.getThread(first.threadId)!.messages[0]).toMatchObject({
    starred: false,
    labelIds: [],
  });
});

test("a stored rule that can't be read is skipped, and the mail still arrives", () => {
  add({ actions: { ...NO_ACTIONS, move: "trash" } });
  db.exec("UPDATE rules SET conditions = 'not json'");
  add({ actions: { ...NO_ACTIONS, star: true } });
  expect(stored(message())).toMatchObject({ folder: "inbox", starred: true });
  db.exec('UPDATE rules SET actions = \'{"move":"gone"}\'');
  expect(stored(message())).toMatchObject({ folder: "inbox", starred: false });
});

test("a broken rule table still leaves the mail in the inbox", () => {
  db.exec("ALTER TABLE rules RENAME TO rules_gone");
  expect(placementFor(message(), db)).toEqual({
    folder: "inbox",
    read: false,
    starred: false,
    labelIds: [],
  });
});

test("no rule can reach a permanent delete, a forward, or an unknown folder", () => {
  for (const move of ["delete", "forward", "sent", "drafts", "inbox"]) {
    expect(
      typeof parseRuleDraft({ ...draft(), actions: { ...NO_ACTIONS, move } }),
    ).toBe("string");
  }
  expect(
    parseRuleDraft(draft({ actions: { ...NO_ACTIONS, move: "trash" } })),
  ).toMatchObject({ actions: { move: "trash" } });
});

test("a rule needs conditions, actions, and bounded text", () => {
  const problem = (overrides: Partial<Record<keyof RuleDraft, unknown>>) =>
    parseRuleDraft({ ...draft(), ...overrides });
  expect(problem({ conditions: [] })).toBe("Add at least one condition.");
  expect(problem({ actions: NO_ACTIONS })).toBe("Add at least one action.");
  expect(problem({ name: "   " })).toBe("Give the rule a name.");
  expect(problem({ conditions: [contains("from", "  ")] })).toContain("Add");
  expect(
    problem({
      conditions: Array(MAX_CONDITIONS + 1).fill(contains("from", "x")),
    }),
  ).toContain(`${MAX_CONDITIONS}`);
  expect(
    problem({
      conditions: [contains("from", "x".repeat(MAX_CONDITION_LENGTH + 1))],
    }),
  ).toContain(`${MAX_CONDITION_LENGTH}`);
  expect(problem({ conditions: [{ kind: "regex", text: ".*" }] })).toContain(
    "couldn't read",
  );
  expect(problem({ actions: { ...NO_ACTIONS, star: "yes" } })).toContain(
    "couldn't read",
  );
});

test("a mailbox has a limit on rules", () => {
  for (let index = 0; index < MAX_RULES; index += 1) add();
  expect(rules.create(draft())).toMatchObject({ ok: false, status: 409 });
});

test("a rule can't point at a label that is gone", () => {
  const gone = label();
  labels.delete(gone);
  const actions = { ...NO_ACTIONS, labelId: gone };
  expect(rules.create(draft({ actions }))).toMatchObject({
    ok: false,
    status: 409,
  });
  const existing = add();
  expect(rules.update(existing.id, draft({ actions }))).toMatchObject({
    ok: false,
    status: 409,
  });
});

test("updating and deleting a rule that is gone is safe", () => {
  const rule: Rule = add();
  rules.delete(rule.id);
  rules.delete(rule.id);
  expect(rules.update(rule.id, draft())).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(rules.list()).toEqual([]);
});

test("deleting a label takes it out of rules, and a rule left with nothing turns off", () => {
  const work = label();
  const onlyLabel = add({ actions: { ...NO_ACTIONS, labelId: work } });
  const labelAndStar = add({
    actions: { ...NO_ACTIONS, labelId: work, star: true },
  });
  labels.delete(work);

  const [first, second] = rules.list();
  expect(first).toMatchObject({
    id: onlyLabel.id,
    enabled: false,
    actions: NO_ACTIONS,
  });
  expect(second).toMatchObject({
    id: labelAndStar.id,
    enabled: true,
    actions: { ...NO_ACTIONS, star: true },
  });
  const arrived = stored(message());
  expect(arrived).toMatchObject({ starred: true, labelIds: [] });
});

test("a large hostile body stays bounded", () => {
  for (let index = 0; index < MAX_RULES; index += 1) {
    add({
      conditions: Array.from({ length: MAX_CONDITIONS }, (_, at) =>
        contains(
          "body",
          `${"a".repeat(MAX_CONDITION_LENGTH - 8)}${index}b${at}`,
        ),
      ),
      match: "any",
    });
  }
  const started = performance.now();
  stored(message({ searchBody: "a".repeat(1024 * 1024) }));
  // Generous, since CI machines vary. The Workers measurement is in the PR.
  expect(performance.now() - started).toBeLessThan(5000);
});

async function grantWith(role: MailboxRole): Promise<MailboxGrant> {
  const { sqlite, d1 } = createTestDatabase();
  const alice = "alice" as UserId;
  sqlite.run("INSERT INTO user (id, name, email) VALUES (?, 'A', 'a@x.org')", [
    alice,
  ]);
  sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'shared', 'x')",
    [MAILBOX_A],
  );
  sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, ?)",
    [MAILBOX_A, alice, role],
  );
  const access = await checkMailboxAccess(d1, alice, MAILBOX_A);
  if (!access.allowed) throw new Error("expected access");
  return access.grant;
}

test("a member can read a mailbox's rules and can't reach a way to change them", async () => {
  const { env } = createTestEnv();
  const manager = openMailboxRuleEditor(env, await grantWith("manager"))!;
  expect(await manager.create(draft())).toMatchObject({ ok: true });

  const member = await grantWith("member");
  expect(openMailboxRuleEditor(env, member)).toBeNull();
  expect(await openMailbox(env, member).listRules()).toHaveLength(1);
});

test("rules run through the real Durable Object on a real delivery", async () => {
  const { env } = createTestEnv();
  const grant = await grantWith("manager");
  const editor = openMailboxRuleEditor(env, grant)!;
  await editor.create(
    draft({
      conditions: [contains("subject", "invoice")],
      actions: { ...NO_ACTIONS, move: "archive", star: true },
    }),
  );
  const raw = eml({ subject: "Your INVOICE", messageId: "a@x" });
  const delivered = await ingest(env, {
    source: "inbound",
    mailboxId: MAILBOX_A,
    raw,
    envelope: { from: "a@x.org", to: "b@x.org" },
  });
  expect(delivered).toMatchObject({ status: "stored", folder: "archive" });

  const again = await ingest(env, {
    source: "inbound",
    mailboxId: MAILBOX_A,
    raw,
    envelope: { from: "a@x.org", to: "b@x.org" },
  });
  expect(again).toMatchObject({ status: "duplicate", folder: "archive" });

  const imported = await ingest(env, {
    source: "import",
    mailboxId: MAILBOX_A,
    raw: eml({ subject: "Old invoice", messageId: "b@x" }),
  });
  expect(imported).toMatchObject({ status: "stored", folder: "archive" });
  const mailbox = openMailbox(env, grant);
  const [message] = (await mailbox.getThread(
    (imported as { threadId: ThreadId }).threadId,
  ))!.messages;
  expect(message!.starred).toBe(false);
});
