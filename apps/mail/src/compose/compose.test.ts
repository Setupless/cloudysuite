import { expect, test } from "bun:test";
import { checkMailboxAccess } from "@cloudysuite/access";
import PostalMime from "postal-mime";
import type { UserId } from "../../../../src/db/schema";
import { createTestDatabase } from "../../../../src/db/test-database";
import { openMailbox } from "../client";
import { ingest } from "../ingest";
import { rawKey } from "../r2-keys";
import { createTestEnv, eml, MAILBOX_A, MAILBOX_B } from "../test-support";
import type { Address, MailboxId, MessageDetail } from "../types";
import type { DraftContent, Editor, OutgoingId } from "./types";
import { MAX_RECIPIENTS, UNDO_WINDOW_MS } from "./types";
import { refusalToSend } from "./validate";

const ALEX = "user-alex" as UserId;
const SAM = "user-sam" as UserId;
const EDITOR: Editor = { id: ALEX, name: "Alex" };
const OWN = "alex@example.com";
const DOMAIN = "example.com";

const person = (address: string, name = ""): Address => ({ name, address });
const newId = () => crypto.randomUUID() as OutgoingId;

function content(overrides: Partial<DraftContent> = {}): DraftContent {
  return {
    from: OWN,
    to: [person("pat@example.org", "Pat")],
    cc: [],
    bcc: [],
    subject: "Hello",
    html: "<p>Hi <b>Pat</b></p>",
    includeQuote: false,
    ...overrides,
  };
}

async function setUp(mailboxId: MailboxId = MAILBOX_A) {
  const { sqlite, d1 } = createTestDatabase();
  const kit = createTestEnv(d1);
  for (const [id, email] of [
    [ALEX, "alex@x.org"],
    [SAM, "sam@x.org"],
  ] as const) {
    sqlite.run("INSERT INTO user (id, name, email) VALUES (?, ?, ?)", [
      id,
      email,
      email,
    ]);
    sqlite.run(
      "INSERT OR IGNORE INTO mailboxes (id, kind, name) VALUES (?, 'shared', 'Team')",
      [mailboxId],
    );
    sqlite.run(
      "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'member')",
      [mailboxId, id],
    );
  }
  sqlite.run("INSERT INTO domains (name, is_primary) VALUES (?, 1)", [DOMAIN]);
  sqlite.run(
    "INSERT INTO addresses (address, domain, mailbox_id, kind) VALUES (?, ?, ?, 'primary')",
    [OWN, DOMAIN, mailboxId],
  );
  const access = await checkMailboxAccess(d1, ALEX, mailboxId);
  if (!access.allowed) throw new Error("expected access");
  const mailbox = openMailbox(kit.env, access.grant);
  const instance = kit.instanceOf(mailboxId);
  const rows = <Row>(query: string, ...values: unknown[]) =>
    instance.sqlite.prepare(query).all(...(values as never[])) as Row[];
  const send = async (id: OutgoingId, overrides?: Partial<DraftContent>) => {
    const result = await mailbox.outgoing.send({
      id,
      content: content(overrides),
      editor: EDITOR,
      ownDomain: DOMAIN,
      fromName: "Alex Doe",
    });
    expect(result.status).toBe("scheduled");
  };
  const stateOf = (id: OutgoingId) =>
    rows<{ state: string }>("SELECT state FROM outgoing WHERE id = ?", id)[0]
      ?.state;
  const deliver = (raw: ArrayBuffer) =>
    ingest(kit.env, {
      source: "inbound",
      mailboxId,
      raw,
      envelope: { from: "pat@example.org", to: OWN },
    });
  const sent = () =>
    rows<{
      id: number;
      thread_id: number;
      folder: string;
      source: string;
      is_read: number;
      bcc_addresses: string;
      r2_prefix: string;
      rfc_message_id: string;
    }>("SELECT * FROM messages WHERE source = 'sent'");
  return {
    ...kit,
    mailbox,
    instance,
    rows,
    send,
    stateOf,
    deliver,
    sent,
    sqlite,
    d1,
  };
}

test("a sent message waits out the undo window, then goes once and lands in Sent as read", async () => {
  const { email, instance, send, stateOf, sent } = await setUp();
  const id = newId();
  await send(id);
  expect(stateOf(id)).toBe("scheduled");
  expect(email.sent).toHaveLength(0);
  expect(instance.alarm).toBeGreaterThanOrEqual(
    Date.now() + UNDO_WINDOW_MS - 2000,
  );

  await instance.fireAlarm();
  expect(email.sent).toHaveLength(1);
  expect(stateOf(id)).toBe("sent");
  const [copy] = sent();
  expect(copy?.folder).toBe("sent");
  expect(copy?.is_read).toBe(1);

  await instance.object.alarm();
  expect(email.sent).toHaveLength(1);
  expect(sent()).toHaveLength(1);
});

test("the message goes out with both parts, and our HTML has been through the sanitizer", async () => {
  const { email, instance, send } = await setUp();
  await send(newId(), {
    html: `<p onclick="alert(1)">Look</p><script>alert(2)</script><img src="https://evil.example/t.png"><a href="javascript:alert(3)">x</a><a href="https://ok.example/">fine</a><ul><li>one</li></ul>`,
  });
  await instance.fireAlarm();
  const [message] = email.sent;
  expect(message?.html).not.toMatch(/onclick|<script|<img|javascript:|alert/i);
  expect(message?.html).toContain("fine");
  expect(message?.text).toContain("Look");
  expect(message?.text).toContain("fine (https://ok.example/)");
  expect(message?.text).toContain("- one");
});

test("undo in the window returns it to a draft, and the alarm then sends nothing", async () => {
  const { mailbox, email, instance, send, stateOf } = await setUp();
  const id = newId();
  await send(id);
  expect(await mailbox.outgoing.undo(id)).toBe(true);
  expect(stateOf(id)).toBe("draft");
  await instance.object.alarm();
  expect(email.sent).toHaveLength(0);
  expect((await mailbox.outgoing.detail(id, ALEX))?.content.subject).toBe(
    "Hello",
  );
});

test("undo is refused once the send has claimed the message", async () => {
  const { mailbox, email, instance, send } = await setUp();
  const id = newId();
  await send(id);
  let duringSend: unknown = null;
  email.beforeAnswer = async () => {
    duringSend = await mailbox.outgoing.undo(id);
  };
  await instance.fireAlarm();
  expect(duringSend === false).toBe(true);
  expect(email.sent).toHaveLength(1);
});

test("a crash during the send ends as unknown and is never sent again", async () => {
  const { email, instance, send, stateOf, restart, sent } = await setUp();
  const id = newId();
  await send(id);
  // A process dying mid-call: the promise never settles for the code that made it.
  email.beforeAnswer = () => new Promise<void>(() => {});
  void instance.fireAlarm();
  await Bun.sleep(5);
  expect(stateOf(id)).toBe("sending");

  restart(MAILBOX_A);
  email.beforeAnswer = null;
  await instance.fireAlarm();
  expect(stateOf(id)).toBe("unknown");
  await instance.object.alarm();
  expect(stateOf(id)).toBe("unknown");
  expect(email.sent).toHaveLength(0);
  expect(sent()).toHaveLength(0);
});

test("a send that ends with no clear answer is unknown, and a clean refusal is failed", async () => {
  const { mailbox, email, instance, send, stateOf } = await setUp();
  const ambiguous = newId();
  await send(ambiguous);
  email.nextThrows.push(new Error("Network connection lost."));
  await instance.fireAlarm();
  expect(stateOf(ambiguous)).toBe("unknown");

  const internal = newId();
  await send(internal);
  email.nextThrows.push(
    Object.assign(new Error("x"), { code: "E_INTERNAL_SERVER_ERROR" }),
  );
  await instance.fireAlarm();
  expect(stateOf(internal)).toBe("unknown");

  const refused = newId();
  await send(refused);
  email.nextThrows.push(
    Object.assign(new Error("no"), { code: "E_SENDER_NOT_VERIFIED" }),
  );
  await instance.fireAlarm();
  expect(stateOf(refused)).toBe("failed");
  const detail = await mailbox.outgoing.detail(refused, ALEX);
  expect(detail?.failure).toBe("senderNotVerified");
  expect(email.sent).toHaveLength(0);

  expect(await mailbox.outgoing.reopen(refused)).toBe(true);
  expect(stateOf(refused)).toBe("draft");
  expect(await mailbox.outgoing.reopen(ambiguous)).toBe(true);
  expect(stateOf(ambiguous)).toBe("draft");
});

test("the daily limit is a plain failure, with no retry", async () => {
  const { mailbox, email, instance, send, stateOf } = await setUp();
  const id = newId();
  await send(id);
  email.nextThrows.push(
    Object.assign(new Error("no"), { code: "E_DAILY_LIMIT_EXCEEDED" }),
  );
  await instance.fireAlarm();
  expect(stateOf(id)).toBe("failed");
  expect((await mailbox.outgoing.detail(id, ALEX))?.failure).toBe("dailyLimit");
  expect(instance.alarm).toBeNull();
});

test("a rate limit retries with growing delays, then fails plainly", async () => {
  const { mailbox, email, instance, send, stateOf } = await setUp();
  const id = newId();
  await send(id);
  const rateLimited = () =>
    Object.assign(new Error("slow"), { code: "E_RATE_LIMIT_EXCEEDED" });
  const delays: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    email.nextThrows.push(rateLimited());
    const before = instance.alarm!;
    await instance.fireAlarm();
    expect(stateOf(id)).toBe("scheduled");
    delays.push(instance.alarm! - before);
  }
  expect(delays[1]!).toBeGreaterThan(delays[0]!);
  expect(delays[2]!).toBeGreaterThan(delays[1]!);

  email.nextThrows.push(rateLimited());
  await instance.fireAlarm();
  expect(stateOf(id)).toBe("failed");
  expect((await mailbox.outgoing.detail(id, ALEX))?.failure).toBe(
    "rateLimited",
  );
});

test("a retry after rate limiting can still be undone, and a later retry sends once", async () => {
  const { mailbox, email, instance, send, stateOf } = await setUp();
  const undone = newId();
  await send(undone);
  email.nextThrows.push(
    Object.assign(new Error("slow"), { code: "E_RATE_LIMIT_EXCEEDED" }),
  );
  await instance.fireAlarm();
  expect(await mailbox.outgoing.undo(undone)).toBe(true);
  expect(stateOf(undone)).toBe("draft");

  const retried = newId();
  await send(retried);
  email.nextThrows.push(
    Object.assign(new Error("slow"), { code: "E_RATE_LIMIT_EXCEEDED" }),
  );
  await instance.fireAlarm();
  await instance.fireAlarm();
  expect(stateOf(retried)).toBe("sent");
  expect(email.sent).toHaveLength(1);
});

test("failing to store the copy never sends again, and a retry stores exactly one", async () => {
  const { bucket, email, instance, send, stateOf, sent } = await setUp();
  const id = newId();
  await send(id);
  bucket.failPutsMatching = /raw\.eml$/;
  await instance.fireAlarm();
  expect(stateOf(id)).toBe("accepted");
  expect(email.sent).toHaveLength(1);
  expect(sent()).toHaveLength(0);

  bucket.failPutsMatching = null;
  await instance.fireAlarm();
  expect(stateOf(id)).toBe("sent");
  expect(email.sent).toHaveLength(1);
  expect(sent()).toHaveLength(1);
});

test("Bcc never reaches the outgoing headers, and only our stored copy shows it", async () => {
  const { bucket, email, instance, send, sent, mailbox } = await setUp();
  await send(newId(), { bcc: [person("secret@example.org", "Secret")] });
  await instance.fireAlarm();
  const [message] = email.sent;
  expect(JSON.stringify(message?.headers)).not.toContain("secret@example.org");
  expect(message?.bcc).toEqual([
    { name: "Secret", email: "secret@example.org" },
  ]);

  const [copy] = sent();
  expect(JSON.parse(copy!.bcc_addresses)).toEqual([
    { name: "Secret", address: "secret@example.org" },
  ]);
  const raw = new TextDecoder().decode(
    bucket.objects.get(rawKey(copy!.r2_prefix)),
  );
  expect(raw).toContain("secret@example.org");
  const thread = await mailbox.getThread(copy!.thread_id as never);
  expect(thread?.messages[0]?.bcc[0]?.address).toBe("secret@example.org");
});

test("a Bcc header on inbound mail is ignored", async () => {
  const { deliver, rows } = await setUp();
  await deliver(
    eml({ messageId: "in@x", headers: ["Bcc: someone@example.org"] }),
  );
  const [row] = rows<{ bcc_addresses: string }>(
    "SELECT bcc_addresses FROM messages",
  );
  expect(row?.bcc_addresses).toBe("[]");
});

test("line breaks in a subject and a name cannot add a header", async () => {
  const { bucket, email, instance, mailbox, sent } = await setUp();
  const id = newId();
  await mailbox.outgoing.send({
    id,
    content: content({
      subject: "Hi\r\nBcc: evil@example.net",
      to: [person("pat@example.org", "Pat\r\nBcc: evil@example.net")],
    }),
    editor: EDITOR,
    ownDomain: DOMAIN,
    fromName: "Alex\r\nBcc: evil@example.net",
  });
  await instance.fireAlarm();
  const [message] = email.sent;
  expect(message?.subject).toBe("Hi Bcc: evil@example.net");
  expect(JSON.stringify(message)).not.toMatch(/\\r|\\n/);
  const raw = new TextDecoder().decode(
    bucket.objects.get(rawKey(sent()[0]!.r2_prefix)),
  );
  expect(raw).not.toMatch(/\r\nBcc:/);
  const parsed = await PostalMime.parse(raw);
  expect(parsed.bcc ?? []).toEqual([]);
  expect(parsed.subject).toBe("Hi Bcc: evil@example.net");
});

test("a line break in an address is refused, by name, before anything is scheduled", async () => {
  const { mailbox, stateOf } = await setUp();
  const id = newId();
  const result = await mailbox.outgoing.send({
    id,
    content: content({ to: [person("a@x.org\r\nBcc: evil@example.net")] }),
    editor: EDITOR,
    ownDomain: DOMAIN,
    fromName: "Alex",
  });
  expect(result.status).toBe("refused");
  if (result.status === "refused") {
    expect(result.refusal.status).toBe(400);
    expect(result.refusal.message).not.toMatch(/[\r\n]/);
    expect(result.refusal.message).toContain(
      "doesn't look like an email address",
    );
  }
  expect(stateOf(id)).toBeUndefined();
});

test("recipient, attachment, and empty limits are refused in plain words", () => {
  const base = {
    plainText: "text",
    bodyBytes: 10,
    quoteBytes: 0,
    attachmentSizes: [],
  };
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, index) =>
    person(`p${index}@example.org`),
  );
  expect(
    refusalToSend({ ...base, content: content({ to: many }) })?.message,
  ).toContain("at most 50 people");
  expect(
    refusalToSend({
      ...base,
      content: content({ to: many.slice(0, 25), cc: many.slice(25, 50) }),
    }),
  ).toBeNull();
  expect(
    refusalToSend({ ...base, content: content({ to: [] }) })?.message,
  ).toContain("Add at least one person");
  expect(
    refusalToSend({ ...base, content: content({ subject: " " }) })?.message,
  ).toContain("Add a subject");
  expect(
    refusalToSend({ ...base, content: content(), plainText: "  " })?.message,
  ).toContain("empty");
  expect(
    refusalToSend({
      ...base,
      content: content(),
      attachmentSizes: Array.from({ length: 33 }, () => 1),
    })?.message,
  ).toContain("at most 32 attachments");
  const eighteenMiB = 18 * 1024 * 1024;
  expect(
    refusalToSend({
      ...base,
      content: content(),
      attachmentSizes: [eighteenMiB],
    }),
  ).toBeNull();
  const refused = refusalToSend({
    ...base,
    content: content(),
    attachmentSizes: [eighteenMiB, 2 * 1024 * 1024],
  });
  expect(refused?.status).toBe(413);
  expect(refused?.message).toContain("25 MB");
});

test("autosave keeps one draft row, with no rows in messages", async () => {
  const { mailbox, rows } = await setUp();
  const id = newId();
  let revision = 0;
  for (const subject of ["a", "ab", "abc"]) {
    const result = await mailbox.outgoing.save({
      id,
      baseRevision: revision,
      content: content({ subject }),
      editor: EDITOR,
      ownDomain: DOMAIN,
    });
    if (result.status !== "saved") throw new Error("expected a save");
    revision = result.revision;
    expect(result.overwrote).toBeNull();
  }
  expect(rows("SELECT id FROM outgoing")).toHaveLength(1);
  expect(rows("SELECT id FROM messages")).toHaveLength(0);
  expect((await mailbox.outgoing.detail(id, ALEX))?.content.subject).toBe(
    "abc",
  );
  const [listed] = await mailbox.outgoing.list(ALEX);
  expect(listed?.subject).toBe("abc");
});

test("two people on one draft: the last save wins, and that person is told", async () => {
  const { mailbox } = await setUp();
  const id = newId();
  const first = await mailbox.outgoing.save({
    id,
    baseRevision: 0,
    content: content({ subject: "Alex's" }),
    editor: EDITOR,
    ownDomain: DOMAIN,
  });
  if (first.status !== "saved") throw new Error("expected a save");
  const sam = await mailbox.outgoing.save({
    id,
    baseRevision: first.revision,
    content: content({ subject: "Sam's" }),
    editor: { id: SAM, name: "Sam" },
    ownDomain: DOMAIN,
  });
  expect(sam).toMatchObject({ status: "saved", overwrote: null });
  const late = await mailbox.outgoing.save({
    id,
    baseRevision: first.revision,
    content: content({ subject: "Alex's again" }),
    editor: EDITOR,
    ownDomain: DOMAIN,
  });
  expect(late).toMatchObject({ status: "saved", overwrote: "Sam" });
  expect((await mailbox.outgoing.detail(id, SAM))?.content.subject).toBe(
    "Alex's again",
  );
});

test("a save cannot change a message already on its way", async () => {
  const { mailbox, send } = await setUp();
  const id = newId();
  await send(id);
  const result = await mailbox.outgoing.save({
    id,
    baseRevision: 2,
    content: content({ subject: "Too late" }),
    editor: { id: SAM, name: "Sam" },
    ownDomain: DOMAIN,
  });
  expect(result).toEqual({ status: "locked", state: "scheduled" });
});

test("a draft's hostile HTML is reduced to what the toolbar can make", async () => {
  const { mailbox } = await setUp();
  const id = newId();
  await mailbox.outgoing.save({
    id,
    baseRevision: 0,
    content: content({
      html: `<div style="position:fixed" class="x" onmouseover="a()"><b>ok</b><img src=x onerror=a()><style>*{display:none}</style><iframe src=//x></iframe><svg onload=a()></svg><a href="https://x.org" style="color:red">link</a></div>`,
    }),
    editor: EDITOR,
    ownDomain: DOMAIN,
  });
  const html = (await mailbox.outgoing.detail(id, ALEX))?.content.html;
  expect(html).toContain("<b>ok</b>");
  expect(html).toContain('href="https://x.org/"');
  expect(html).not.toMatch(
    /style|class|onmouseover|<img|<iframe|<svg|onerror/i,
  );
});

test("a draft keeps its attachments across saves, and they go when it is sent", async () => {
  const { bucket, email, instance, mailbox, send, rows, sent } = await setUp();
  const id = newId();
  const upload = await mailbox.outgoing.upload({
    id,
    fileName: 'report\r\nX-Evil: 1".pdf',
    mimeType: "application/pdf",
    body: {
      declaredBytes: 4,
      read: async () => new TextEncoder().encode("%PDF").buffer as ArrayBuffer,
    },
    fromAddress: OWN,
    editor: EDITOR,
  });
  expect(upload.status).toBe("added");
  await mailbox.outgoing.save({
    id,
    baseRevision: 1,
    content: content(),
    editor: EDITOR,
    ownDomain: DOMAIN,
  });
  expect((await mailbox.outgoing.detail(id, ALEX))?.attachments).toHaveLength(
    1,
  );
  await send(id);
  await instance.fireAlarm();

  const [message] = email.sent;
  expect(message?.attachments).toHaveLength(1);
  expect(message?.attachments?.[0]?.filename).not.toMatch(/[\r\n"]/);
  expect(message?.attachments?.[0]?.content).toBe(btoa("%PDF"));
  expect(rows("SELECT id FROM outgoing_attachments")).toHaveLength(0);
  expect(rows<{ size: number }>("SELECT size FROM attachments")[0]?.size).toBe(
    4,
  );
  const queued = rows<{ prefix: string }>("SELECT prefix FROM r2_deletions");
  expect(queued.map(({ prefix }) => prefix).join()).toContain("/outgoing/");
  expect(bucket.keys(sent()[0]!.r2_prefix).length).toBeGreaterThan(0);
});

test("uploads over the limits are refused, and a refused file leaves nothing behind", async () => {
  const { bucket, mailbox } = await setUp();
  const id = newId();
  const body = (bytes: number) => ({
    declaredBytes: bytes,
    read: async () => new ArrayBuffer(bytes),
  });
  const upload = (bytes: number) =>
    mailbox.outgoing.upload({
      id,
      fileName: "a.bin",
      mimeType: "",
      body: body(bytes),
      fromAddress: OWN,
      editor: EDITOR,
    });
  expect(await upload(20 * 1024 * 1024)).toMatchObject({
    status: "refused",
    httpStatus: 413,
  });
  expect(await upload(0)).toMatchObject({ status: "refused", httpStatus: 400 });

  expect((await upload(15 * 1024 * 1024)).status).toBe("added");
  const objects = bucket.keys().length;
  expect(await upload(5 * 1024 * 1024)).toMatchObject({
    status: "refused",
    httpStatus: 413,
  });
  expect(bucket.keys()).toHaveLength(objects);
});

test("the 33rd attachment is refused", async () => {
  const { mailbox } = await setUp();
  const id = newId();
  const upload = () =>
    mailbox.outgoing.upload({
      id,
      fileName: "a.txt",
      mimeType: "text/plain",
      body: { declaredBytes: 1, read: async () => new ArrayBuffer(1) },
      fromAddress: OWN,
      editor: EDITOR,
    });
  for (let index = 0; index < 32; index += 1) {
    expect((await upload()).status).toBe("added");
  }
  expect(await upload()).toMatchObject({ status: "refused", httpStatus: 400 });
});

test("discarding a draft removes its row and queues its files; a message on its way can't be discarded", async () => {
  const { mailbox, rows, send, stateOf } = await setUp();
  const id = newId();
  await mailbox.outgoing.save({
    id,
    baseRevision: 0,
    content: content(),
    editor: EDITOR,
    ownDomain: DOMAIN,
  });
  expect(await mailbox.outgoing.discard(id)).toBe(true);
  expect(stateOf(id)).toBeUndefined();
  expect(
    rows<{ prefix: string }>("SELECT prefix FROM r2_deletions")[0]?.prefix,
  ).toContain(`/outgoing/${id}/`);

  const going = newId();
  await send(going);
  expect(await mailbox.outgoing.discard(going)).toBe(false);
  expect(stateOf(going)).toBe("scheduled");
});

async function parentOf(kit: Awaited<ReturnType<typeof setUp>>) {
  const result = await kit.deliver(
    eml({
      from: "Pat <pat@example.org>",
      to: `${OWN}, Jo <jo@example.org>`,
      cc: "Kim <kim@example.org>",
      subject: "Plans",
      date: "Sat, 31 Oct 2026 10:00:00 +0000",
      messageId: "parent@example.org",
      references: "<root@example.org>",
    }),
  );
  if (result.status !== "stored") throw new Error("expected a stored message");
  const thread = await kit.mailbox.getThread(result.threadId);
  return {
    parent: thread!.messages[0] as MessageDetail,
    threadId: result.threadId,
  };
}

const startFrom = (
  kit: Awaited<ReturnType<typeof setUp>>,
  parent: MessageDetail,
  mode: "reply" | "replyAll" | "forward",
  id = newId(),
) =>
  kit.mailbox.outgoing.start({
    id,
    mode,
    parent,
    body: { text: "Original text", html: null },
    inlineAttachments: [],
    ownAddresses: [OWN],
    ownDomain: DOMAIN,
    editor: EDITOR,
  });

test("a reply answers the sender, reply all the others, and neither includes us", async () => {
  const kit = await setUp();
  const { parent } = await parentOf(kit);
  const reply = await startFrom(kit, parent, "reply");
  expect(reply.draft.content.to.map(({ address }) => address)).toEqual([
    "pat@example.org",
  ]);
  expect(reply.draft.content.cc).toEqual([]);
  expect(reply.draft.content.subject).toBe("Re: Plans");

  const all = await startFrom(kit, parent, "replyAll");
  expect(all.draft.content.to.map(({ address }) => address)).toEqual([
    "pat@example.org",
  ]);
  expect(all.draft.content.cc.map(({ address }) => address)).toEqual([
    "jo@example.org",
    "kim@example.org",
  ]);

  const forward = await startFrom(kit, parent, "forward");
  expect(forward.draft.content.to).toEqual([]);
  expect(forward.draft.content.subject).toBe("Fwd: Plans");
});

test("starting the same draft twice keeps one row", async () => {
  const kit = await setUp();
  const { parent } = await parentOf(kit);
  const id = newId();
  await startFrom(kit, parent, "reply", id);
  await startFrom(kit, parent, "reply", id);
  expect(kit.rows("SELECT id FROM outgoing")).toHaveLength(1);
});

test("a reply threads for the recipient and in our own copy, with the quote", async () => {
  const kit = await setUp();
  const { parent, threadId } = await parentOf(kit);
  const { draft } = await startFrom(kit, parent, "reply");
  await kit.mailbox.outgoing.send({
    id: draft.id,
    content: { ...draft.content, html: "<p>Agreed</p>" },
    editor: EDITOR,
    ownDomain: DOMAIN,
    fromName: "Alex",
  });
  await kit.instance.fireAlarm();

  const [message] = kit.email.sent;
  expect(message?.headers).toMatchObject({
    "In-Reply-To": "<parent@example.org>",
    References: "<root@example.org> <parent@example.org>",
  });
  expect(message?.html).toContain("Agreed");
  expect(message?.html).toContain("Original text");
  expect(message?.text).toContain("> Original text");

  const thread = await kit.mailbox.getThread(threadId);
  expect(thread?.messages.map((one) => one.source)).toEqual([
    "inbound",
    "sent",
  ]);
});

test("a sent reply joins its conversation's labels and rules leave it alone", async () => {
  const kit = await setUp();
  const { parent, threadId } = await parentOf(kit);
  const created = await kit.mailbox.createLabel("Work", "secondary");
  if (!created.ok) throw new Error("expected a label");
  const { label } = created;
  await kit.mailbox.setLabel({ threadIds: [threadId] }, label.id, true);
  kit.instance.object.createRule({
    name: "Move everything",
    enabled: true,
    match: "any",
    conditions: [{ kind: "contains", field: "subject", text: "Plans" }],
    actions: { move: "trash", star: true, markRead: false, labelId: null },
  });

  const { draft } = await startFrom(kit, parent, "reply");
  await kit.mailbox.outgoing.send({
    id: draft.id,
    content: { ...draft.content, html: "<p>Agreed on the budget</p>" },
    editor: EDITOR,
    ownDomain: DOMAIN,
    fromName: "Alex",
  });
  await kit.instance.fireAlarm();

  const thread = await kit.mailbox.getThread(threadId);
  expect(thread?.messages.at(-1)).toMatchObject({
    source: "sent",
    folder: "sent",
    starred: false,
    labelIds: [label.id],
  });

  const found = await kit.mailbox.search({
    text: "in:sent budget",
    offsetMinutes: 0,
  });
  expect(found.threads.map((one) => one.id)).toEqual([threadId]);
});

test("a reply from outside threads through the returned id, or through our own reference if that id was never the header", async () => {
  const kit = await setUp();
  const id = newId();
  await kit.send(id);
  kit.email.nextMessageId = "<cf-id@sending.example>";
  await kit.instance.fireAlarm();
  const [copy] = kit.sent();
  expect(copy?.rfc_message_id).toBe("cf-id@sending.example");

  const viaId = await kit.deliver(
    eml({
      from: "Pat <pat@example.org>",
      to: OWN,
      subject: "Re: Hello",
      messageId: "answer-1@example.org",
      inReplyTo: "cf-id@sending.example",
    }),
  );
  expect(viaId).toMatchObject({ status: "stored", threadId: copy?.thread_id });

  const other = newId();
  await kit.send(other, { subject: "Another" });
  kit.email.nextMessageId = "opaque-token-not-the-header";
  await kit.instance.fireAlarm();
  const headers = kit.email.sent[1]?.headers as Record<string, string>;
  const viaOwn = await kit.deliver(
    eml({
      from: "Pat <pat@example.org>",
      to: OWN,
      subject: "Re: Another",
      messageId: "answer-2@example.org",
      inReplyTo: "the-real-header-id@sending.example",
      references: `${headers.References} <the-real-header-id@sending.example>`,
    }),
  );
  const anotherCopy = kit.sent().find((row) => row.id !== copy?.id);
  expect(viaOwn).toMatchObject({
    status: "stored",
    threadId: anotherCopy?.thread_id,
  });
});

test("a long chain of references is cut to fit Cloudflare's header limit, keeping root and parent", async () => {
  const kit = await setUp();
  const long = Array.from(
    { length: 45 },
    (_, index) => `ancestor-${index}-${"x".repeat(60)}@example.org`,
  );
  const result = await kit.deliver(
    eml({
      from: "Pat <pat@example.org>",
      to: OWN,
      subject: "Long",
      messageId: "tip@example.org",
      references: long.map((id) => `<${id}>`).join(" "),
    }),
  );
  if (result.status !== "stored") throw new Error("expected a stored message");
  const thread = await kit.mailbox.getThread(result.threadId);
  const { draft } = await startFrom(kit, thread!.messages[0]!, "reply");
  await kit.mailbox.outgoing.send({
    id: draft.id,
    content: { ...draft.content, html: "<p>x</p>" },
    editor: EDITOR,
    ownDomain: DOMAIN,
    fromName: "Alex",
  });
  await kit.instance.fireAlarm();
  const references = (kit.email.sent[0]?.headers as Record<string, string>)
    .References!;
  expect(references.length).toBeLessThanOrEqual(2048);
  expect(references.startsWith(`<${long[0]}>`)).toBe(true);
  expect(references.endsWith("<tip@example.org>")).toBe(true);
});

test("a message to your own address lands in Sent and in the Inbox, threaded together", async () => {
  const kit = await setUp();
  await kit.send(newId(), { to: [person(OWN)] });
  kit.email.nextMessageId = "<note@sending.example>";
  await kit.instance.fireAlarm();
  const headers = kit.email.sent[0]?.headers as Record<string, string>;
  expect(Object.keys(headers)).toEqual(["References"]);

  const delivered = await kit.deliver(
    eml({
      from: `Alex Doe <${OWN}>`,
      to: OWN,
      subject: "Hello",
      messageId: "note@sending.example",
      references: headers.References,
      headers: ["Received: from mx by us"],
      body: "As delivered",
    }),
  );
  const [copy] = kit.sent();
  expect(delivered).toMatchObject({
    status: "stored",
    folder: "inbox",
    threadId: copy?.thread_id,
  });
  expect(copy?.folder).toBe("sent");
  expect(kit.rows("SELECT id FROM messages")).toHaveLength(2);
});

test("a note to yourself that arrives before the sent copy is stored still threads with it", async () => {
  const kit = await setUp();
  await kit.send(newId(), { to: [person(OWN)] });
  let delivered: Awaited<ReturnType<typeof kit.deliver>> | undefined;
  kit.email.nextMessageId = "<not-the-delivered-header@sending.example>";
  kit.email.beforeAnswer = async () => {
    const { References } = kit
      .rows<{ id: string }>("SELECT id FROM outgoing")
      .map(({ id }) => ({ References: `<${id}@${DOMAIN}>` }))[0]!;
    delivered = await kit.deliver(
      eml({
        from: `Alex Doe <${OWN}>`,
        to: OWN,
        subject: "Hello",
        messageId: "real-header@sending.example",
        references: References,
      }),
    );
  };
  await kit.instance.fireAlarm();
  expect(delivered).toMatchObject({ status: "stored", folder: "inbox" });
  expect(kit.sent()).toHaveLength(1);
  const { threadId } = delivered as { threadId: number };
  expect(kit.sent()[0]?.thread_id).toBe(threadId);
  const { messages } = (await kit.mailbox.getThread(threadId as never))!;
  expect(messages.map(({ source }) => source).sort()).toEqual([
    "inbound",
    "sent",
  ]);
});

test("no header can make inbound mail vanish", async () => {
  const kit = await setUp();
  const id = newId();
  await kit.send(id);
  kit.email.nextMessageId = "<known@sending.example>";
  await kit.instance.fireAlarm();
  const stranger = { from: "stranger@evil.test", to: OWN };
  const forged = (options: Parameters<typeof eml>[0]) =>
    ingest(kit.env, {
      source: "inbound",
      mailboxId: MAILBOX_A,
      raw: eml({ from: `Payroll <${OWN}>`, to: OWN, ...options }),
      envelope: stranger,
    });

  for (const options of [
    {
      subject: "Pay now",
      messageId: "new@evil.test",
      headers: [`X-CloudySuite-Send: ${id}`],
    },
    { subject: "Pay today", messageId: "known@sending.example" },
    {
      subject: "Pay this week",
      messageId: "another@evil.test",
      headers: [`X-CloudySuite-Send: ${newId()}`],
    },
  ]) {
    expect((await forged(options)).status).toBe("stored");
  }
  expect(
    kit
      .rows<{ subject: string }>(
        "SELECT subject FROM messages WHERE source = 'inbound' ORDER BY id",
      )
      .map(({ subject }) => subject),
  ).toEqual(["Pay now", "Pay today", "Pay this week"]);
  const queued = kit.rows<{ prefix: string }>(
    "SELECT prefix FROM r2_deletions",
  );
  expect(queued.every(({ prefix }) => prefix.includes("/outgoing/"))).toBe(
    true,
  );
});

test("only byte-identical redelivery counts as a duplicate", async () => {
  const kit = await setUp();
  const raw = eml({
    from: "Pat <pat@example.org>",
    to: OWN,
    subject: "Twice",
    messageId: "twice@example.org",
  });
  expect((await kit.deliver(raw)).status).toBe("stored");
  expect((await kit.deliver(raw)).status).toBe("duplicate");
  expect(kit.rows("SELECT id FROM messages")).toHaveLength(1);
});

const RATE_LIMIT = () =>
  Object.assign(new Error("slow down"), { code: "E_RATE_LIMIT_EXCEEDED" });

// Each thing that can change while a message waits, as the admin screens would do it.
const CHANGES_WHILE_QUEUED = [
  {
    name: "its From address moved to another mailbox",
    failure: "fromAddressGone",
    change: ({ sqlite }: Awaited<ReturnType<typeof setUp>>) => {
      sqlite.run(
        "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'shared', 'Other')",
        [MAILBOX_B],
      );
      sqlite.run("UPDATE addresses SET mailbox_id = ? WHERE address = ?", [
        MAILBOX_B,
        OWN,
      ]);
    },
  },
  {
    name: "the sender lost access to the mailbox",
    failure: "senderLostAccess",
    change: ({ sqlite }: Awaited<ReturnType<typeof setUp>>) => {
      sqlite.run("DELETE FROM mailbox_access WHERE user_id = ?", [ALEX]);
    },
  },
  {
    name: "the sender was banned",
    failure: "senderLostAccess",
    change: ({ sqlite }: Awaited<ReturnType<typeof setUp>>) => {
      sqlite.run("UPDATE user SET banned = 1 WHERE id = ?", [ALEX]);
    },
  },
  {
    name: "Mail was turned off",
    failure: "mailOff",
    change: ({ sqlite }: Awaited<ReturnType<typeof setUp>>) => {
      sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
    },
  },
] as const;

for (const { name, failure, change } of CHANGES_WHILE_QUEUED) {
  test(`nothing goes out when ${name} during the undo window, and it stays a draft to fix`, async () => {
    const kit = await setUp();
    const id = newId();
    await kit.send(id);
    change(kit);
    await kit.instance.fireAlarm();
    expect(kit.email.sent).toHaveLength(0);
    expect(kit.stateOf(id)).toBe("failed");
    expect((await kit.mailbox.outgoing.detail(id, ALEX))?.failure).toBe(
      failure,
    );
    expect(await kit.mailbox.outgoing.reopen(id)).toBe(true);
    expect((await kit.mailbox.outgoing.detail(id, ALEX))?.content.subject).toBe(
      "Hello",
    );
  });

  test(`a rate-limit retry checks again, and nothing goes out when ${name} while it waited`, async () => {
    const kit = await setUp();
    const id = newId();
    await kit.send(id);
    kit.email.nextThrows.push(RATE_LIMIT());
    await kit.instance.fireAlarm();
    expect(kit.stateOf(id)).toBe("scheduled");
    change(kit);
    await kit.instance.fireAlarm();
    expect(kit.email.sent).toHaveLength(0);
    expect(kit.stateOf(id)).toBe("failed");
    expect((await kit.mailbox.outgoing.detail(id, ALEX))?.failure).toBe(
      failure,
    );
  });
}

test("the check follows whoever pressed Send, not whoever wrote the draft", async () => {
  const kit = await setUp();
  const id = newId();
  await kit.mailbox.outgoing.save({
    id,
    baseRevision: 0,
    content: content(),
    editor: { id: SAM, name: "Sam" },
    ownDomain: DOMAIN,
  });
  await kit.send(id);
  kit.sqlite.run("DELETE FROM mailbox_access WHERE user_id = ?", [SAM]);
  await kit.instance.fireAlarm();
  expect(kit.email.sent).toHaveLength(1);

  const second = newId();
  await kit.send(second);
  kit.sqlite.run("DELETE FROM mailbox_access WHERE user_id = ?", [ALEX]);
  await kit.instance.fireAlarm();
  expect(kit.email.sent).toHaveLength(1);
  expect(kit.stateOf(second)).toBe("failed");
});

const brokenDirectory = (kit: Awaited<ReturnType<typeof setUp>>) => {
  const down = () => {
    throw new Error("D1_ERROR: database unavailable");
  };
  const target = kit.env as unknown as { DB: unknown };
  target.DB = { prepare: down, batch: down };
  return () => {
    target.DB = kit.d1;
  };
};

test("a directory outage never becomes a send: it waits, checks again, then goes once", async () => {
  const kit = await setUp();
  const id = newId();
  await kit.send(id);
  const restore = brokenDirectory(kit);
  const before = kit.instance.alarm!;
  await kit.instance.fireAlarm();
  expect(kit.email.sent).toHaveLength(0);
  expect(kit.stateOf(id)).toBe("scheduled");
  expect(kit.instance.alarm).toBeGreaterThanOrEqual(before + 30_000);

  await kit.instance.fireAlarm();
  expect(kit.email.sent).toHaveLength(0);
  restore();
  await kit.instance.fireAlarm();
  expect(kit.email.sent).toHaveLength(1);
  expect(kit.stateOf(id)).toBe("sent");
});

test("a directory that stays down ends the retries with a failure, and nothing goes out", async () => {
  const kit = await setUp();
  const id = newId();
  await kit.send(id);
  brokenDirectory(kit);
  for (let tries = 0; tries < 4; tries += 1) {
    expect(kit.stateOf(id)).toBe("scheduled");
    await kit.instance.fireAlarm();
  }
  expect(kit.email.sent).toHaveLength(0);
  expect(kit.stateOf(id)).toBe("failed");
  expect((await kit.mailbox.outgoing.detail(id, ALEX))?.failure).toBe(
    "checkUnavailable",
  );
  expect(kit.instance.alarm).toBeNull();
});

test("undo while the check runs stops the send", async () => {
  const kit = await setUp();
  const id = newId();
  await kit.send(id);
  const real = kit.d1.batch.bind(kit.d1);
  let undone = false;
  kit.d1.batch = (async (statements: never[]) => {
    if (!undone) {
      undone = true;
      await kit.mailbox.outgoing.undo(id);
    }
    return real(statements);
  }) as typeof kit.d1.batch;
  await kit.instance.fireAlarm();
  expect(undone).toBe(true);
  expect(kit.email.sent).toHaveLength(0);
  expect(kit.stateOf(id)).toBe("draft");
});

test("undo and a new Send while the check runs keep the new undo window and the new words", async () => {
  const kit = await setUp();
  const id = newId();
  await kit.send(id);
  const real = kit.d1.batch.bind(kit.d1);
  let resent = false;
  kit.d1.batch = (async (statements: never[]) => {
    if (!resent) {
      resent = true;
      await kit.mailbox.outgoing.undo(id);
      await kit.send(id, { subject: "Corrected" });
    }
    return real(statements);
  }) as typeof kit.d1.batch;
  await kit.instance.fireAlarm();
  expect(resent).toBe(true);
  expect(kit.email.sent).toHaveLength(0);
  expect(kit.stateOf(id)).toBe("scheduled");

  kit.d1.batch = real;
  await kit.instance.fireAlarm();
  expect(kit.email.sent.map(({ subject }) => subject)).toEqual(["Corrected"]);
});

test("someone listed in To, Cc, and Bcc gets one copy, whatever the capitals", async () => {
  const kit = await setUp();
  const id = newId();
  await kit.send(id, {
    to: [person("Pat@Example.org", "Pat")],
    cc: [person("pat@example.org"), person("kim@example.org")],
    bcc: [
      person("PAT@EXAMPLE.ORG"),
      person("kim@EXAMPLE.org"),
      person("hidden@example.org"),
    ],
  });
  await kit.instance.fireAlarm();
  const [message] = kit.email.sent;
  expect(message?.to).toEqual([{ name: "Pat", email: "Pat@Example.org" }]);
  expect(message?.cc).toEqual(["kim@example.org"]);
  expect(message?.bcc).toEqual(["hidden@example.org"]);
});

test("the recipient limit counts people, not entries", async () => {
  const kit = await setUp();
  const people = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      person(`person-${index}@example.org`),
    );
  const fifty = people(MAX_RECIPIENTS);
  const allowed = newId();
  await kit.send(allowed, {
    to: fifty,
    bcc: fifty.map(({ address }) => person(address.toUpperCase())),
  });
  await kit.instance.fireAlarm();
  expect(kit.email.sent[0]?.to).toHaveLength(MAX_RECIPIENTS);
  expect(kit.email.sent[0]?.bcc).toBeUndefined();

  const refused = await kit.mailbox.outgoing.send({
    id: newId(),
    content: content({
      to: fifty,
      bcc: [...fifty, person("one-more@example.org")],
    }),
    editor: EDITOR,
    ownDomain: DOMAIN,
    fromName: "Alex",
  });
  expect(refused).toMatchObject({
    status: "refused",
    refusal: { status: 400 },
  });
});

test("forwarding carries the attachments along, and they survive the original being deleted", async () => {
  const kit = await setUp();
  const raw = new TextEncoder().encode(
    [
      "From: Pat <pat@example.org>",
      `To: ${OWN}`,
      "Subject: Contract",
      "Message-ID: <fwd@example.org>",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "See attached.",
      "--b",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="contract.pdf"',
      "",
      btoa("%PDF-1.4"),
      "--b--",
    ].join("\r\n"),
  ).buffer as ArrayBuffer;
  const delivered = await kit.deliver(raw);
  if (delivered.status !== "stored")
    throw new Error("expected a stored message");
  const thread = await kit.mailbox.getThread(delivered.threadId);
  const parent = thread!.messages[0]!;
  const { draft } = await kit.mailbox.outgoing.start({
    id: newId(),
    mode: "forward",
    parent,
    body: await kit.mailbox.getBody(parent.id).then((body) => body!),
    inlineAttachments: parent.attachments.map((info) => ({
      info,
      read: async () => {
        const download = await kit.mailbox.getAttachment(parent.id, info.id);
        return download ? new Response(download.body).arrayBuffer() : null;
      },
    })),
    ownAddresses: [OWN],
    ownDomain: DOMAIN,
    editor: EDITOR,
  });
  expect(draft.attachments.map(({ filename }) => filename)).toEqual([
    "contract.pdf",
  ]);
  await kit.mailbox.moveToTrash({ messageIds: [parent.id] });
  await kit.mailbox.deleteForever({ messageIds: [parent.id] });
  await kit.instance.object.alarm();

  await kit.mailbox.outgoing.send({
    id: draft.id,
    content: {
      ...draft.content,
      to: [person("jo@example.org")],
      html: "<p>FYI</p>",
    },
    editor: EDITOR,
    ownDomain: DOMAIN,
    fromName: "Alex",
  });
  await kit.instance.fireAlarm();
  const [message] = kit.email.sent;
  expect(message?.attachments?.[0]?.content).toBe(btoa("%PDF-1.4"));
  expect(message?.html).toContain("Forwarded message");
  expect(message?.text).toContain("See attached.");
});

test("a quoted hostile message goes out sanitized", async () => {
  const kit = await setUp();
  const { parent } = await parentOf(kit);
  const { draft } = await kit.mailbox.outgoing.start({
    id: newId(),
    mode: "reply",
    parent,
    body: {
      text: null,
      html: `<p onclick="x()">Hi</p><script>alert(1)</script><iframe src="https://evil.example"></iframe><img src=x onerror=alert(2)>`,
    },
    inlineAttachments: [],
    ownAddresses: [OWN],
    ownDomain: DOMAIN,
    editor: EDITOR,
  });
  const preview = await kit.mailbox.outgoing.quoteHtml(draft.id);
  expect(preview).toContain("Hi");
  expect(preview).not.toMatch(/onclick|<script|<iframe|onerror|alert/i);

  await kit.mailbox.outgoing.send({
    id: draft.id,
    content: { ...draft.content, html: "<p>Reply</p>" },
    editor: EDITOR,
    ownDomain: DOMAIN,
    fromName: "Alex",
  });
  await kit.instance.fireAlarm();
  expect(kit.email.sent[0]?.html).not.toMatch(
    /onclick|<script|<iframe|onerror|alert/i,
  );
});

test("leaving the quote out sends only what was written", async () => {
  const kit = await setUp();
  const { parent } = await parentOf(kit);
  const { draft } = await startFrom(kit, parent, "reply");
  await kit.mailbox.outgoing.send({
    id: draft.id,
    content: {
      ...draft.content,
      html: "<p>Just this</p>",
      includeQuote: false,
    },
    editor: EDITOR,
    ownDomain: DOMAIN,
    fromName: "Alex",
  });
  await kit.instance.fireAlarm();
  expect(kit.email.sent[0]?.html).not.toContain("Original text");
  expect(kit.email.sent[0]?.text).not.toContain("Original text");
});

test("address suggestions come from past correspondents, and leave out spam and other mailboxes", async () => {
  const kit = await setUp();
  await kit.deliver(
    eml({ from: "Priya Raman <priya@example.org>", to: OWN, messageId: "p@x" }),
  );
  await kit.send(newId(), { to: [person("quinn@example.org", "Quinn")] });
  await kit.instance.fireAlarm();
  const suggest = (query: string) => kit.mailbox.outgoing.suggest(query);
  expect(await suggest("pri")).toEqual([
    { name: "Priya Raman", address: "priya@example.org" },
  ]);
  expect((await suggest("raman"))[0]?.address).toBe("priya@example.org");
  expect((await suggest("quinn"))[0]?.address).toBe("quinn@example.org");
  expect(await suggest("%")).toEqual([]);
  expect(await suggest("nobody")).toEqual([]);

  const other = await setUp(MAILBOX_B);
  expect(await other.mailbox.outgoing.suggest("pri")).toEqual([]);
});

test("the stored copy's bytes parse back to what was written, including non-English text", async () => {
  const { bucket, instance, send, sent } = await setUp();
  await send(newId(), {
    subject:
      "Grüße aus Köln 日本語の件名がとても長い場合でも正しく折り返されること",
    to: [person("pat@example.org", 'Müller, "Pat"')],
    html: "<p>Héllo 🌏</p>",
  });
  await instance.fireAlarm();
  const parsed = await PostalMime.parse(
    bucket.objects.get(rawKey(sent()[0]!.r2_prefix))!,
  );
  expect(parsed.subject).toBe(
    "Grüße aus Köln 日本語の件名がとても長い場合でも正しく折り返されること",
  );
  expect(parsed.to?.[0]?.name).toBe('Müller, "Pat"');
  expect(parsed.to?.[0]?.address).toBe("pat@example.org");
  expect(parsed.html).toContain("Héllo 🌏");
  expect(parsed.text).toContain("Héllo 🌏");
});

test("queueing other work keeps the send's earlier wake-up", async () => {
  const { env, instance, send } = await setUp();
  await send(newId());
  const due = instance.alarm!;
  await env.MAILBOX.get(env.MAILBOX.idFromName(MAILBOX_A)).abandonUpload("x/");
  expect(instance.alarm).toBe(due);
});
