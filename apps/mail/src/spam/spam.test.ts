import { beforeEach, expect, test } from "bun:test";
import {
  checkMailboxAccess,
  type MailboxGrant,
  type UserId,
} from "@cloudysuite/access";
import type { MailboxRole } from "../../../../src/db/schema";
import { createTestDatabase } from "../../../../src/db/test-database";
import { openMailbox, openMailboxSenderListEditor } from "../client";
import { ingest } from "../ingest";
import { LabelStore } from "../labels/store";
import { RuleStore } from "../rules/store";
import type { RuleDraft } from "../rules/types";
import type { SqlDriver } from "../sql";
import { MailboxStore } from "../store";
import {
  createTestEnv,
  eml,
  type EmlOptions,
  MAILBOX_A,
} from "../test-support";
import type { Folder, MessageDetail, MessageId, ThreadId } from "../types";
import { whyInSpam } from "./explain";
import { findMisleadingLink, provedDomain, runnableFilename } from "./signals";
import {
  MAX_CONTACTS,
  MAX_MODEL_TOKENS,
  MIN_SPAM_SAMPLES,
  SpamStore,
} from "./store";
import { MAX_TOKENS_PER_MESSAGE, SCAN_CHARS, tokensOf } from "./tokens";
import {
  MAX_SENDER_ENTRIES,
  parseSenderPattern,
  parseStoredVerdict,
} from "./types";

let env: Env;
let db: SqlDriver;
let store: MailboxStore;
let spam: SpamStore;
let serial = 0;

beforeEach(() => {
  const test = createTestEnv();
  env = test.env;
  ({ db } = test.instanceOf(MAILBOX_A));
  store = new MailboxStore(db);
  spam = new SpamStore(db);
});

const cloudflare = (results: string) =>
  `Authentication-Results: mx.cloudflare.net; ${results}`;
const DMARC_PASS = cloudflare(
  "dkim=pass header.d=example.org; dmarc=pass header.from=example.org; spf=pass",
);
const DMARC_FAIL = cloudflare(
  "dkim=none; dmarc=fail header.from=example.org; spf=fail",
);

async function deliver(options: EmlOptions = {}) {
  serial += 1;
  const result = await ingest(env, {
    source: "inbound",
    mailboxId: MAILBOX_A,
    raw: eml({ messageId: `m${serial}@x`, ...options }),
    envelope: { from: "a@example.org", to: "b@example.com" },
  });
  if (result.status === "tooLarge") throw new Error("too large");
  return result;
}

const detail = (threadId: ThreadId, messageId: MessageId): MessageDetail =>
  store.getThread(threadId)!.messages.find((one) => one.id === messageId)!;

const CAMPAIGN = {
  subject: "Exclusive pharmacy discount shipped overnight worldwide",
  body: "Order discount pharmacy tablets online today with discreet overnight shipping. Lowest price guaranteed on generic bestselling medication. Secure checkout, satisfied customers everywhere.",
};
const campaign = (sender: number) => ({
  from: `offers${sender}@bulk-pharmacy.example`,
  subject: CAMPAIGN.subject,
  body: CAMPAIGN.body,
});

async function mark(count: number) {
  const marked = [];
  for (let index = 0; index < count; index += 1) {
    const message = await deliver(campaign(index));
    store.moveToFolder({ messageIds: [message.messageId] }, "spam");
    marked.push(message);
  }
  return marked;
}

function modelState() {
  return {
    documents: db.exec("SELECT spam_docs, ham_docs FROM spam_model").toArray(),
    tokens: db
      .exec("SELECT token, spam, ham FROM spam_tokens ORDER BY token")
      .toArray(),
  };
}

test("a forged result below Cloudflare's own header counts for nothing", async () => {
  const forged = await deliver({
    headers: [DMARC_FAIL, DMARC_PASS],
    from: "Bank <alerts@example.org>",
  });
  expect(forged.folder).toBe("spam");
  const unforged = await deliver({
    headers: [DMARC_PASS, DMARC_FAIL],
    from: "Bank <alerts@example.org>",
  });
  expect(unforged.folder).toBe("inbox");
});

test("a first header from any other server is not read, whatever it says", async () => {
  const claimed = await deliver({
    headers: ["Authentication-Results: evil.example; dmarc=fail"],
  });
  expect(claimed.folder).toBe("inbox");
  const message = await deliver({
    headers: [
      "Authentication-Results: evil.example; dmarc=pass header.from=example.org",
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.org",
    ],
  });
  expect(detail(message.threadId, message.messageId).authResults).toBeNull();
});

test("mail that fails DMARC lands in Spam and says so in plain words", async () => {
  const message = await deliver({ headers: [DMARC_FAIL] });
  expect(message.folder).toBe("spam");
  expect(whyInSpam(detail(message.threadId, message.messageId))).toContain(
    "failed the sender checks",
  );
});

test("nothing is ever refused: every message is stored and can be read", async () => {
  for (const headers of [[DMARC_FAIL], [DMARC_PASS]]) {
    const message = await deliver({ headers });
    expect(message.status).toBe("stored");
    expect(store.getThread(message.threadId)).not.toBeNull();
  }
});

test("a few odd things together are spam, and one alone is not", async () => {
  const oneOdd = await deliver({
    subject: "PLEASE CALL ME ABOUT THE QUOTE",
    headers: ["Reply-To: Bob <bob@other.example>", DMARC_PASS],
  });
  expect(oneOdd.folder).toBe("inbox");

  const several = await deliver({
    from: '"support@bank.example" <x@bulk.example>',
    subject: "VERIFY YOUR ACCOUNT TODAY NOW",
    headers: [
      "Reply-To: Bob <bob@other.example>",
      cloudflare("spf=softfail; dkim=fail; dmarc=none"),
    ],
  });
  expect(several.folder).toBe("spam");
  expect(whyInSpam(detail(several.threadId, several.messageId))).toContain(
    "support@bank.example",
  );
});

test("a program attached by a stranger goes to Spam, and from someone known it doesn't", async () => {
  await deliver({ from: "Colleague <c@example.org>", headers: [DMARC_PASS] });
  const raw = (from: string, id: string) =>
    new TextEncoder().encode(
      [
        DMARC_PASS,
        `From: ${from}`,
        "To: b@example.com",
        "Subject: The tool",
        `Message-ID: <${id}>`,
        'Content-Type: multipart/mixed; boundary="part"',
        "",
        "--part",
        "Content-Type: text/plain",
        "",
        "Here is the tool.",
        "--part",
        'Content-Type: application/octet-stream; name="tool.pdf.exe"',
        'Content-Disposition: attachment; filename="tool.pdf.exe"',
        "",
        "AAAA",
        "--part--",
      ].join("\r\n"),
    ).buffer as ArrayBuffer;
  const send = (from: string, id: string) =>
    ingest(env, {
      source: "inbound",
      mailboxId: MAILBOX_A,
      raw: raw(from, id),
      envelope: { from: "a@example.org", to: "b@example.com" },
    });
  expect(await send("Colleague <c@example.org>", "known@x")).toMatchObject({
    folder: "inbox",
  });
  expect(await send("Stranger <new@example.org>", "new@x")).toMatchObject({
    folder: "spam",
  });
});

const rule = (overrides: Partial<RuleDraft>): RuleDraft => ({
  name: "A rule",
  enabled: true,
  match: "all",
  conditions: [{ kind: "contains", field: "from", text: "boss@example.org" }],
  actions: { move: null, labelId: null, markRead: false, star: false },
  ...overrides,
});

test("a rule can't route a forged From past the filter, and its label and star still apply", async () => {
  const label = new LabelStore(db, new RuleStore(db)).create("VIP", "accent");
  if (!label.ok) throw new Error("label");
  new RuleStore(db).create(
    rule({
      actions: {
        move: "archive",
        labelId: label.label.id,
        markRead: false,
        star: true,
      },
    }),
  );
  const forged = await deliver({
    from: "The Boss <boss@example.org>",
    headers: [DMARC_FAIL],
  });
  expect(forged.folder).toBe("spam");
  const stored = detail(forged.threadId, forged.messageId);
  expect(stored.starred).toBe(true);
  expect(stored.labelIds).toEqual([label.label.id]);
});

test("a rule still decides for mail the filter has no problem with", async () => {
  new RuleStore(db).create(
    rule({
      actions: { move: "trash", labelId: null, markRead: false, star: false },
    }),
  );
  const real = await deliver({
    from: "The Boss <boss@example.org>",
    headers: [DMARC_PASS],
  });
  expect(real.folder).toBe("trash");
});

test("a rule that moves mail to Spam says that is why it is there", async () => {
  new RuleStore(db).create(
    rule({
      actions: { move: "spam", labelId: null, markRead: false, star: false },
    }),
  );
  const message = await deliver({
    from: "The Boss <boss@example.org>",
    headers: [DMARC_PASS],
  });
  expect(message.folder).toBe("spam");
  expect(whyInSpam(detail(message.threadId, message.messageId))).toBe(
    "A rule in this mailbox moved this here.",
  );
});

test("a blocked address or domain goes to Spam, whatever else is true", async () => {
  spam.addSender("pest@example.org", "block");
  spam.addSender("noisy.example", "block");
  const pest = await deliver({
    from: "Pest <pest@example.org>",
    headers: [DMARC_PASS],
  });
  expect(pest.folder).toBe("spam");
  expect(whyInSpam(detail(pest.threadId, pest.messageId))).toContain(
    "pest@example.org is on this mailbox's block list",
  );
  const sub = await deliver({ from: "A <a@mail.noisy.example>" });
  expect(sub.folder).toBe("spam");
  expect((await deliver({ from: "Other <other@example.org>" })).folder).toBe(
    "inbox",
  );
});

test("an allowed sender with proof lands in the inbox even if it looks wrong", async () => {
  spam.addSender("friend@example.org", "allow");
  const message = await deliver({
    from: "friend@bank.example <friend@example.org>",
    subject: "VERY LOUD SUBJECT LINE HERE",
    headers: ["Reply-To: Other <o@other.example>", DMARC_PASS],
  });
  expect(message.folder).toBe("inbox");
});

test("the same allowed From with failing proof gets no special treatment", async () => {
  spam.addSender("friend@example.org", "allow");
  const message = await deliver({
    from: "Friend <friend@example.org>",
    headers: [DMARC_FAIL],
  });
  expect(message.folder).toBe("spam");
  expect(whyInSpam(detail(message.threadId, message.messageId))).toContain(
    "couldn't prove it came from them",
  );
});

test("a passing signature for some other domain proves nothing about the From line", async () => {
  spam.addSender("example.org", "block");
  spam.addSender("friend@example.org", "allow");
  const forged = await deliver({
    from: "Friend <friend@example.org>",
    headers: [
      cloudflare(
        "dkim=pass header.d=attacker.example; dmarc=none header.from=example.org; spf=pass",
      ),
    ],
  });
  expect(forged.folder).toBe("spam");
  const domainClaim = await deliver({
    from: "Friend <friend@example.org>",
    headers: [
      cloudflare(
        "dkim=none; dmarc=pass header.from=attacker.example; spf=pass",
      ),
    ],
  });
  expect(domainClaim.folder).toBe("spam");
});

test("proof means a pass for the From line's own domain", () => {
  const from = { name: "", address: "a@mail.example.org" };
  const base = { spf: null, dkim: null, dmarc: null };
  const proved = (auth: object) =>
    provedDomain({ ...base, ...auth }, from) !== null;
  expect(proved({ dmarc: "pass", dmarcDomain: "mail.example.org" })).toBe(true);
  expect(proved({ dmarc: "pass" })).toBe(false);
  expect(proved({ dmarc: "pass", dmarcDomain: "evil.example" })).toBe(false);
  expect(proved({ dkim: "pass", dkimPassDomains: ["example.org"] })).toBe(true);
  expect(proved({ dkim: "pass", dkimPassDomains: ["org.example"] })).toBe(
    false,
  );
  expect(proved({ dkim: "pass", dkimPassDomains: ["ample.org"] })).toBe(false);
  expect(
    proved({
      dmarc: "fail",
      dkim: "pass",
      dkimPassDomains: ["mail.example.org"],
    }),
  ).toBe(false);
  expect(provedDomain(null, from)).toBeNull();
});

test("a long run of subdomains doesn't escape a blocked domain", async () => {
  spam.addSender("noisy.example", "block");
  const message = await deliver({
    from: "A <a@a.b.c.d.e.f.g.h.i.j.k.l.noisy.example>",
  });
  expect(message.folder).toBe("spam");
});

test("the narrowest list entry decides", async () => {
  spam.addSender("example.org", "block");
  spam.addSender("friend@example.org", "allow");
  const friend = await deliver({
    from: "Friend <friend@example.org>",
    headers: [DMARC_PASS],
  });
  expect(friend.folder).toBe("inbox");
  const stranger = await deliver({
    from: "Stranger <stranger@example.org>",
    headers: [DMARC_PASS],
  });
  expect(stranger.folder).toBe("spam");
});

test("adding a sender to the other list moves it there", () => {
  spam.addSender("a@example.org", "block");
  spam.addSender("a@example.org", "allow");
  expect(spam.listSenders()).toEqual([
    { pattern: "a@example.org", list: "allow" },
  ]);
  spam.removeSender("a@example.org");
  expect(spam.listSenders()).toEqual([]);
});

test("the lists have a limit, and it says what to do", () => {
  for (let index = 0; index < MAX_SENDER_ENTRIES; index += 1) {
    expect(spam.addSender(`a${index}@example.org`, "block").ok).toBe(true);
  }
  const full = spam.addSender("one-more@example.org", "block");
  expect(full).toMatchObject({ ok: false, status: 409 });
  expect(spam.addSender("a1@example.org", "allow").ok).toBe(true);
});

test("a list entry is one address or one domain", () => {
  expect(parseSenderPattern(" Bob@Example.ORG ")).toBe("bob@example.org");
  expect(parseSenderPattern("@Example.org")).toBe("example.org");
  expect(parseSenderPattern("mail.example.org")).toBe("mail.example.org");
  for (const bad of [
    "",
    "com",
    "bob",
    "bob@",
    "Bob <bob@example.org>",
    "a@b@example",
    "two words.example",
    "example.org, other.org",
    `${"a".repeat(260)}.org`,
    null,
    7,
  ]) {
    expect(parseSenderPattern(bad)).toBeNull();
  }
});

test("learning does nothing before the minimum sample, then files similar mail", async () => {
  await mark(MIN_SPAM_SAMPLES - 1);
  expect((await deliver(campaign(100))).folder).toBe("inbox");
  await mark(1);
  const similar = await deliver(campaign(101));
  expect(similar.folder).toBe("spam");
  expect(whyInSpam(detail(similar.threadId, similar.messageId))).toContain(
    "marked as spam",
  );
});

test("what was learned doesn't file different mail", async () => {
  await mark(MIN_SPAM_SAMPLES + 3);
  const real = await deliver({
    from: "Dana <dana@example.org>",
    subject: "Lunch next week?",
    body: "Are you free on Tuesday? There is a new place near the office that does good soup, and I would like to hear how the move went for your team.",
  });
  expect(real.folder).toBe("inbox");
});

test("marking and then not-spam leaves the model exactly as it was", async () => {
  await mark(2);
  const before = modelState();
  const message = await deliver({
    ...campaign(50),
    body: "Fresh words about something else entirely here.",
  });
  store.moveToFolder({ messageIds: [message.messageId] }, "spam");
  expect(modelState()).not.toEqual(before);
  store.restore({ messageIds: [message.messageId] });
  expect(modelState()).toEqual(before);
  expect(detail(message.threadId, message.messageId).spamTraining).toBeNull();
});

test("undoing a mark and undoing a not-spam both put the model back", async () => {
  const message = await deliver(campaign(1));
  const empty = modelState();

  const refs = store.moveToFolder({ messageIds: [message.messageId] }, "spam");
  store.moveToFolder({ messageIds: [message.messageId] }, refs[0]!.folder);
  expect(modelState()).toEqual(empty);

  const filed = await deliver({ ...campaign(2), headers: [DMARC_FAIL] });
  store.restore({ messageIds: [filed.messageId] });
  expect(detail(filed.threadId, filed.messageId).spamTraining).toBe("ham");
  store.moveToFolder({ messageIds: [filed.messageId] }, "spam");
  expect(modelState()).toEqual(empty);
});

test("moving twice counts once", async () => {
  const message = await deliver(campaign(1));
  store.moveToFolder({ messageIds: [message.messageId] }, "spam");
  const once = modelState();
  store.moveToFolder({ messageIds: [message.messageId] }, "spam");
  store.moveToFolder(
    { threadIds: [message.threadId], inFolder: "inbox" },
    "spam",
  );
  expect(modelState()).toEqual(once);
  expect(once.documents).toEqual([{ spam_docs: 1, ham_docs: 0 }]);
});

test("taking mail out of Spam twice counts once", async () => {
  const filed = await deliver({ ...campaign(2), headers: [DMARC_FAIL] });
  store.restore({ messageIds: [filed.messageId] });
  const once = modelState();
  store.restore({ messageIds: [filed.messageId] });
  expect(modelState()).toEqual(once);
  expect(once.documents).toEqual([{ spam_docs: 0, ham_docs: 1 }]);
});

test("moving through Trash teaches nothing, and undoing that teaches nothing", async () => {
  const filed = await deliver({ ...campaign(2), headers: [DMARC_FAIL] });
  const empty = modelState();
  store.moveToFolder({ messageIds: [filed.messageId] }, "trash");
  store.moveToFolder({ messageIds: [filed.messageId] }, "spam");
  expect(modelState()).toEqual(empty);
});

test("restoring a marked message from Trash takes the mark back", async () => {
  const empty = modelState();
  const message = await deliver(campaign(1));
  store.moveToFolder({ messageIds: [message.messageId] }, "spam");
  store.moveToFolder({ messageIds: [message.messageId] }, "trash");
  store.restore({ messageIds: [message.messageId] });
  expect(modelState()).toEqual(empty);
});

test("one not-spam outweighs the marks that taught it", async () => {
  await mark(MIN_SPAM_SAMPLES + 2);
  const filed = await deliver(campaign(100));
  expect(filed.folder).toBe("spam");
  store.restore({ messageIds: [filed.messageId] });
  expect((await deliver(campaign(101))).folder).toBe("inbox");
});

test("not-spam on the marked messages themselves returns to knowing nothing", async () => {
  const marked = await mark(MIN_SPAM_SAMPLES);
  expect((await deliver(campaign(100))).folder).toBe("spam");
  for (const message of marked) {
    store.restore({ messageIds: [message.messageId] });
  }
  expect(modelState().documents).toEqual([{ spam_docs: 0, ham_docs: 0 }]);
  expect((await deliver(campaign(101))).folder).toBe("inbox");
});

test("a sender this mailbox knows and who proves it isn't filed for sounding similar", async () => {
  await deliver({ from: "Vendor <v@example.org>", headers: [DMARC_PASS] });
  await mark(MIN_SPAM_SAMPLES);
  const known = await deliver({
    ...campaign(0),
    from: "Vendor <v@example.org>",
    headers: [DMARC_PASS],
  });
  expect(known.folder).toBe("inbox");
  const forged = await deliver({
    ...campaign(0),
    from: "Vendor <v@example.org>",
  });
  expect(forged.folder).toBe("spam");
});

test("marking a known sender teaches the filter about them", async () => {
  const mailFrom = () =>
    deliver({
      ...campaign(0),
      from: "Letter <news@example.org>",
      headers: [DMARC_PASS],
    });
  for (let index = 0; index < MIN_SPAM_SAMPLES; index += 1) {
    const issue = await mailFrom();
    expect(issue.folder).toBe("inbox");
    store.moveToFolder({ messageIds: [issue.messageId] }, "spam");
  }
  expect((await mailFrom()).folder).toBe("spam");
});

test("an allowed sender stays allowed however much like spam it reads", async () => {
  await mark(MIN_SPAM_SAMPLES + 1);
  spam.addSender("bulk-pharmacy.example", "allow");
  const message = await deliver({
    ...campaign(9),
    headers: [
      cloudflare(
        "dkim=pass header.d=bulk-pharmacy.example; dmarc=none; spf=pass",
      ),
    ],
  });
  expect(message.folder).toBe("inbox");
});

test("what was learned can't argue down a failed sender check", async () => {
  for (let index = 0; index < 4; index += 1) {
    const filed = await deliver({ ...campaign(index), headers: [DMARC_FAIL] });
    expect(filed.folder).toBe("spam");
    store.restore({ messageIds: [filed.messageId] });
  }
  const forged = await deliver({ ...campaign(9), headers: [DMARC_FAIL] });
  expect(forged.folder).toBe("spam");
  expect(
    detail(forged.threadId, forged.messageId).spam?.reasons,
  ).toContainEqual({ kind: "learnedReal" });
});

test("redelivery changes nothing: no new score, no new training", async () => {
  const raw = eml({ ...campaign(1), messageId: "again@x" });
  const send = () =>
    ingest(env, {
      source: "inbound",
      mailboxId: MAILBOX_A,
      raw,
      envelope: { from: "a@example.org", to: "b@example.com" },
    });
  const first = await send();
  if (first.status === "tooLarge") throw new Error("too large");
  store.moveToFolder({ messageIds: [first.messageId] }, "spam");
  const state = modelState();
  const again = await send();
  expect(again).toMatchObject({
    status: "duplicate",
    messageId: first.messageId,
    folder: "spam",
  });
  expect(modelState()).toEqual(state);
});

test("imported and sent mail skip the filter, even when they look forged", async () => {
  const noted = () =>
    db.exec("SELECT COUNT(*) AS total FROM spam_contacts").toArray()[0];
  spam.addSender("example.org", "block");
  const raw = (id: string) =>
    eml({
      headers: [DMARC_FAIL],
      messageId: id,
      to: "friend@elsewhere.example",
    });
  const imported = await ingest(env, {
    source: "import",
    mailboxId: MAILBOX_A,
    raw: raw("i@x"),
  });
  expect(imported).toMatchObject({ folder: "archive" });
  expect(noted()).toEqual({ total: 0 });
  expect(modelState().tokens).toEqual([]);
  const sent = await ingest(env, {
    source: "sent",
    mailboxId: MAILBOX_A,
    raw: raw("s@x"),
  });
  expect(sent).toMatchObject({ folder: "sent" });
  expect(noted()).toEqual({ total: 1 });
});

test("imported mail teaches only when a person acts on it", async () => {
  const imported = await ingest(env, {
    source: "import",
    mailboxId: MAILBOX_A,
    raw: eml({ ...campaign(1), messageId: "i@x" }),
  });
  if (imported.status === "tooLarge") throw new Error("too large");
  expect(modelState().documents).toEqual([{ spam_docs: 0, ham_docs: 0 }]);
  store.moveToFolder({ messageIds: [imported.messageId] }, "spam");
  expect(modelState().documents).toEqual([{ spam_docs: 1, ham_docs: 0 }]);
});

test("someone you wrote to is not a stranger, and neither is someone you said was real", async () => {
  await ingest(env, {
    source: "sent",
    mailboxId: MAILBOX_A,
    raw: eml({ to: "Pal <pal@example.org>", messageId: "s@x" }),
  });
  const pal = await deliver({
    from: "Pal <pal@example.org>",
    headers: [DMARC_FAIL],
  });
  expect(detail(pal.threadId, pal.messageId).spam?.reasons).not.toContainEqual({
    kind: "firstContact",
  });
  const filed = await deliver({
    from: "New <new@example.org>",
    headers: [DMARC_FAIL],
  });
  expect(detail(filed.threadId, filed.messageId).spam?.reasons).toContainEqual({
    kind: "firstContact",
  });
  store.restore({ messageIds: [filed.messageId] });
  const later = await deliver({
    from: "New <new@example.org>",
    headers: [DMARC_FAIL],
  });
  expect(
    detail(later.threadId, later.messageId).spam?.reasons,
  ).not.toContainEqual({
    kind: "firstContact",
  });
});

test("a message that fills the spam folder doesn't vouch for its sender", async () => {
  await deliver({ from: "Bad <bad@example.org>", headers: [DMARC_FAIL] });
  const next = await deliver({
    from: "Bad <bad@example.org>",
    headers: [DMARC_FAIL],
  });
  expect(detail(next.threadId, next.messageId).spam?.reasons).toContainEqual({
    kind: "firstContact",
  });
});

test("a hostile body is read only as far as the limit", () => {
  const words = Array.from({ length: 200_000 }, (_, index) => `word${index}x`);
  const tokens = tokensOf({
    subject: "hello there friend",
    text: words.join(" "),
    provedDomain: null,
  });
  expect(tokens.length).toBeLessThanOrEqual(MAX_TOKENS_PER_MESSAGE);
  expect(
    tokensOf({
      subject: null,
      text: `${" ".repeat(SCAN_CHARS)}onlyhereafterthelimit`,
      provedDomain: null,
    }),
  ).toEqual([]);
});

test("a large body held in R2 can still be marked and taken back", async () => {
  const big = `${"lots of words ".repeat(120_000)}`;
  const message = await deliver({ ...campaign(1), body: big });
  const empty = modelState();
  store.moveToFolder({ messageIds: [message.messageId] }, "spam");
  expect(modelState().documents).toEqual([{ spam_docs: 1, ham_docs: 0 }]);
  store.restore({ messageIds: [message.messageId] });
  expect(modelState()).toEqual(empty);
});

test("the model stays under its cap and forgets the weakest tokens first", async () => {
  db.exec(
    `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?)
     INSERT INTO spam_tokens (token, spam, ham, touched_at)
     SELECT n, 1, 0, n FROM numbers`,
    MAX_MODEL_TOKENS,
  );
  db.exec(
    "INSERT INTO spam_tokens (token, spam, ham, touched_at) VALUES (-1, 50, 0, 0)",
  );
  await mark(1);
  const [{ total, strong } = { total: 0, strong: 0 }] = db
    .exec<{ total: number; strong: number }>(
      "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE token = -1) AS strong FROM spam_tokens",
    )
    .toArray();
  expect(total).toBeLessThanOrEqual(MAX_MODEL_TOKENS);
  expect(strong).toBe(1);
});

test("the list of known senders stays under its cap", async () => {
  db.exec(
    `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n <= ?)
     INSERT INTO spam_contacts (address, last_at) SELECT 'a' || n || '@x.example', n FROM numbers`,
    MAX_CONTACTS,
  );
  await deliver({ from: "New <new@example.org>" });
  const [row] = db
    .exec<{ total: number; present: number }>(
      "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE address = 'new@example.org') AS present FROM spam_contacts",
    )
    .toArray();
  expect(row!.total).toBeLessThanOrEqual(MAX_CONTACTS);
  expect(row!.present).toBe(1);
});

test("a problem in the filter still delivers the mail", async () => {
  db.exec("ALTER TABLE spam_senders RENAME TO spam_senders_gone");
  const message = await deliver({ headers: [DMARC_FAIL] });
  expect(message).toMatchObject({ status: "stored", folder: "inbox" });
});

test("a problem remembering a sender still delivers the mail", async () => {
  db.exec("ALTER TABLE spam_contacts RENAME TO spam_contacts_gone");
  const message = await deliver({ from: "New <new@example.org>" });
  expect(message).toMatchObject({ status: "stored" });
});

test("a stored reason from a newer or broken release can't break the message", () => {
  expect(parseStoredVerdict("not json")).toBeNull();
  expect(parseStoredVerdict(null)).toBeNull();
  expect(
    parseStoredVerdict(
      '{"spam":true,"score":10,"reasons":[{"kind":"gone"},{"kind":"shouting"}]}',
    ),
  ).toEqual({ spam: true, score: 10, reasons: [{ kind: "shouting" }] });
});

test("the reason shown is the strongest, and marks by a person say so", () => {
  const verdict = (
    ...reasons: NonNullable<MessageDetail["spam"]>["reasons"]
  ) => ({ spam: true, score: 0, reasons });
  expect(
    whyInSpam({
      spam: verdict(
        { kind: "firstContact" },
        { kind: "shouting" },
        { kind: "senderCheckFailed" },
      ),
      spamTraining: null,
    }),
  ).toStartWith("This message failed the sender checks");
  expect(
    whyInSpam({ spam: verdict({ kind: "shouting" }), spamTraining: "spam" }),
  ).toBe("Someone using this mailbox marked this as spam.");
  expect(whyInSpam({ spam: null, spamTraining: null })).toBe(
    "This message was moved here.",
  );
});

test("a link is misleading only when its text names another site", () => {
  const link = (href: string, text: string) =>
    findMisleadingLink(`<p><a class="x" href="${href}">${text}</a></p>`);
  expect(link("http://evil.example/x", "https://www.bank.com/login")).toEqual({
    shown: "bank.com",
    actual: "evil.example",
  });
  expect(link("https://paypal.com@evil.example/", "paypal.com")).toEqual({
    shown: "paypal.com",
    actual: "evil.example",
  });
  expect(link("https://www.bank.com/a", "https://bank.com")).toBeNull();
  expect(link("https://mail.bank.co.uk/a", "www.bank.co.uk")).toBeNull();
  expect(link("http://evil.example/x", "Click here")).toBeNull();
  expect(link("http://evil.example/x", "report.pdf")).toBeNull();
  expect(link("mailto:a@evil.example", "www.bank.com")).toBeNull();
  expect(link("not a url", "www.bank.com")).toBeNull();
  expect(
    findMisleadingLink(`<A HREF='http://evil.example'><b>www.bank.com</b></A>`),
  ).toMatchObject({ actual: "evil.example" });
  expect(findMisleadingLink(null)).toBeNull();
});

test("hostile markup can't slow the link check down", () => {
  const started = performance.now();
  findMisleadingLink("<a ".repeat(5_000_000));
  findMisleadingLink("<a href=x>".repeat(2_000_000));
  findMisleadingLink(`${"<a href=x>y</a>".repeat(1_000_000)}`);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("a program is recognized by its last extension", () => {
  const named = (filename: string | null) => runnableFilename([{ filename }]);
  expect(named("invoice.pdf.EXE")).toBe("invoice.pdf.EXE");
  expect(named("invoice.scr. ")).toBe("invoice.scr. ");
  expect(named("invoice.pdf")).toBeNull();
  expect(named("exe")).toBeNull();
  expect(named(null)).toBeNull();
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

test("a member can read the lists and mark mail, and can't reach a way to change the lists", async () => {
  const manager = openMailboxSenderListEditor(env, await grantWith("manager"))!;
  expect(await manager.add("pest@example.org", "block")).toMatchObject({
    ok: true,
  });

  const member = await grantWith("member");
  expect(openMailboxSenderListEditor(env, member)).toBeNull();
  const mailbox = openMailbox(env, member);
  expect(await mailbox.listSenders()).toHaveLength(1);
  const message = await deliver({ from: "Other <other@example.org>" });
  await mailbox.moveToFolder({ messageIds: [message.messageId] }, "spam");
  const moved: Folder = detail(message.threadId, message.messageId).folder;
  expect(moved).toBe("spam");
  expect(modelState().documents).toEqual([{ spam_docs: 1, ham_docs: 0 }]);
});
