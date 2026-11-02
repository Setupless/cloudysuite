import { expect, test } from "bun:test";
import type { MailboxId } from "@cloudysuite/access";
import { createTestDatabase } from "../../../../src/db/test-database";
import { addresses, domains, mailboxes } from "../../../../src/db/schema";
import { MAILBOX_A, MAILBOX_B } from "../test-support";
import { recipientLabel } from "../ui/format";
import type { AttachmentId, MessageDetail, MessageId } from "../types";
import { drizzle } from "drizzle-orm/d1";
import { buildQuote, htmlToPlainText } from "./body";
import { mailboxSenderFacts, refuseSenderOutsideMailbox } from "./addresses";
import { replyRecipients, composeSubject, defaultFromAddress } from "./reply";
import { judgeSendError } from "./send-outcome";
import { toEmailBuilder } from "./outgoing-message";
import { storedMessageId, threadingHeaders } from "./threading-headers";
import { isEditorLink } from "./editor-tags";
import { holdsSomethingAdded } from "./added";
import { discardWhenSettled } from "./discard";
import {
  isLeftOut,
  keptAsText,
  keptCopyId,
  keptHoldsSomething,
  keptNoteText,
  leftOutOf,
  leftOutText,
  moveToDrafts,
  parseKeptDraft,
  parseKeptNote,
  withoutAccess,
} from "./kept";
import { parseOutgoingId } from "./wire";
import {
  type DraftContent,
  type DraftHolds,
  type DraftPrefill,
  fitsSendLimit,
  type KeptDraft,
  type KeptNote,
  type KeptSaveResult,
  NOTHING_PREFILLED,
  type OutgoingId,
  writtenBytes,
} from "./types";
import { isValidAddress, parseAddressList } from "./validate";

const person = (address: string, name = "") => ({ name, address });

const keptDraft: KeptDraft = {
  id: "kept-id" as OutgoingId,
  mailboxId: MAILBOX_A as KeptDraft["mailboxId"],
  keptAt: 1,
  revision: 3,
  mode: "new",
  parent: null,
  quote: null,
  quoteHtml: null,
  attachments: [],
  prefill: NOTHING_PREFILLED,
  content: {
    from: "alex@example.com",
    to: [],
    cc: [],
    bcc: [],
    subject: "Words",
    html: "<p>Written on a train</p>",
    includeQuote: false,
  },
};

const HOLDS_ALL = (draft: KeptDraft) => ({
  attachmentIds: draft.attachments.map((file) => file.id),
  carriedFrom: [],
  quote: draft.quote !== null,
  threaded: draft.parent !== null,
});

const savedHolding = (holds: DraftHolds): KeptSaveResult => ({
  status: "saved",
  revision: 4,
  holds,
});

const keptForward: KeptDraft = {
  ...keptDraft,
  id: "00000000-0000-4000-8000-000000000001" as OutgoingId,
  mode: "forward",
  parent: { messageId: 9 as MessageId, rfcMessageId: "a@b", references: [] },
  quote: { bytes: 20, designed: false },
  quoteHtml: "<p>Original</p>",
  attachments: [
    {
      id: 1,
      filename: "alpha.pdf",
      mimeType: "a/b",
      size: 1,
      carriedFrom: null,
    },
    {
      id: 2,
      filename: "beta.pdf",
      mimeType: "a/b",
      size: 1,
      carriedFrom: null,
    },
  ],
  content: { ...keptDraft.content, includeQuote: true },
};

const blank: Pick<DraftContent, "to" | "cc" | "bcc" | "subject" | "html"> = {
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  html: "",
};
const holds = (
  content: Partial<typeof blank>,
  prefill: DraftPrefill = NOTHING_PREFILLED,
  uploads = 0,
) =>
  holdsSomethingAdded({ content: { ...blank, ...content }, uploads }, prefill);

test.each([
  "",
  "   ",
  "<br>",
  "<p><br></p>",
  "<div><br></div><div>&nbsp;</div>",
  "<p>&#xa0; \u00a0</p>",
  "<ul><li></li></ul>",
  "<b></b>\u200b",
  '<a href="https://example.org"></a>',
])("a body of %j counts as nothing", (html) => {
  expect(holds({ html })).toBe(false);
});

test.each(["hi", "<p>hi</p>", "&lt;", "<ul><li>a</li></ul>", "0"])(
  "a body of %j counts as something",
  (html) => {
    expect(holds({ html })).toBe(true);
  },
);

test("any recipient, subject, or uploaded file on a new message counts", () => {
  expect(holds({})).toBe(false);
  expect(holds({ subject: "   " })).toBe(false);
  expect(holds({ subject: "Hi" })).toBe(true);
  expect(holds({ to: [person("a@x.org")] })).toBe(true);
  expect(holds({ cc: [person("a@x.org")] })).toBe(true);
  expect(holds({ bcc: [person("a@x.org")] })).toBe(true);
  expect(holds({}, NOTHING_PREFILLED, 1)).toBe(true);
});

test("a reply's prefill doesn't count, and any change from it does", () => {
  const prefill: DraftPrefill = {
    to: [person("Pat@x.org", "Pat"), person("jo@x.org")],
    cc: [person("kim@x.org")],
    subject: "Re: Plans",
  };
  const as = { to: prefill.to, cc: prefill.cc, subject: prefill.subject };
  expect(holds(as, prefill)).toBe(false);
  expect(
    holds(
      {
        ...as,
        to: [person("jo@x.org"), person("pat@x.org")],
        subject: " Re:  Plans ",
      },
      prefill,
    ),
  ).toBe(false);
  expect(holds({ ...as, html: "<p>Agreed</p>" }, prefill)).toBe(true);
  expect(holds({ ...as, subject: "Re: Other plans" }, prefill)).toBe(true);
  expect(holds({ ...as, to: [person("jo@x.org")] }, prefill)).toBe(true);
  expect(holds({ ...as, cc: [] }, prefill)).toBe(true);
  expect(holds({ ...as, bcc: [person("boss@x.org")] }, prefill)).toBe(true);
});

const keptReply: KeptDraft = {
  ...keptDraft,
  id: "00000000-0000-4000-8000-000000000002" as OutgoingId,
  revision: 0,
  mode: "forward",
  parent: { messageId: 9 as MessageId, rfcMessageId: "a@b", references: [] },
  quote: { bytes: 20, designed: false },
  quoteHtml: "<p>Original</p>",
  prefill: { to: [person("pat@x.org")], cc: [], subject: "Fwd: Plans" },
  attachments: [
    {
      id: 7,
      filename: "plan.pdf",
      mimeType: "a/b",
      size: 1,
      carriedFrom: 7 as AttachmentId,
    },
  ],
  content: {
    from: "alex@example.com",
    to: [person("pat@x.org")],
    cc: [],
    bcc: [],
    subject: "Fwd: Plans",
    html: "<br>",
    includeQuote: true,
  },
};

test("kept text holding only what a reply opened with is never saved", async () => {
  expect(keptHoldsSomething(keptReply)).toBe(false);
  const moved = await moveToDrafts(keptReply, async () => {
    throw new Error("nothing should be asked of the server");
  });
  expect(moved).toBeNull();
});

test("the server's word that kept text holds nothing leaves no draft", async () => {
  const moved = await moveToDrafts(keptDraft, async () => ({
    status: "nothing",
  }));
  expect(moved).toBeNull();
});

test("a kept reply's first save finds its files by where they came from", async () => {
  const written = {
    ...keptReply,
    content: { ...keptReply.content, html: "<p>Agreed</p>" },
  };
  expect(keptHoldsSomething(written)).toBe(true);
  const moved = await moveToDrafts(written, async () =>
    savedHolding({
      attachmentIds: [1],
      carriedFrom: [7],
      quote: true,
      threaded: true,
    }),
  );
  expect(moved?.leftOut).toEqual({ files: [], quote: false, reply: false });
  const lost = await moveToDrafts(written, async () =>
    savedHolding({
      attachmentIds: [7],
      carriedFrom: [8],
      quote: true,
      threaded: true,
    }),
  );
  expect(lost?.leftOut.files).toEqual(["plan.pdf"]);
});

test("a kept row from an earlier build counts everything it holds as added", () => {
  const { prefill: _prefill, ...earlier } = keptDraft;
  const parsed = parseKeptDraft({
    ...earlier,
    id: keptForward.id,
    content: { ...keptDraft.content, to: [person("pat@x.org")], subject: "" },
    attachments: [{ id: 1, filename: "a", mimeType: "a/b", size: 1 }],
  })!;
  expect(parsed.prefill).toEqual(NOTHING_PREFILLED);
  expect(parsed.attachments[0]?.carriedFrom).toBeNull();
  expect(keptHoldsSomething(parsed)).toBe(true);
  expect(
    parseKeptDraft({ ...earlier, id: keptForward.id, prefill: { to: "x" } }),
  ).toBeNull();
});

test("words kept on a device go to their own draft", async () => {
  const { savedAs, leftOut, changed } = (await moveToDrafts(
    keptDraft,
    async () => savedHolding(HOLDS_ALL(keptDraft)),
  ))!;
  expect(savedAs).toBe(keptDraft.id);
  expect(isLeftOut(leftOut)).toBe(false);
  expect(changed).toBeNull();
});

test("words kept for a message someone has since sent become a new draft", async () => {
  const { savedAs, leftOut, changed } = (await moveToDrafts(
    keptForward,
    async (copyId) => ({
      status: "copied",
      copyId,
      copyIsDraft: true,
      changed: null,
    }),
  ))!;
  expect(savedAs).toBe(await keptCopyId(keptForward.id, keptForward.keptAt));
  expect(changed).toBeNull();
  expect(leftOut).toEqual({
    files: ["alpha.pdf", "beta.pdf"],
    quote: true,
    reply: false,
  });
});

test("words beside a draft that moved on say who changed it", async () => {
  const moved = (await moveToDrafts(keptForward, async (copyId) => ({
    status: "copied",
    copyId,
    copyIsDraft: true,
    changed: { by: "Sam" },
  })))!;
  expect(moved.changed).toEqual({ by: "Sam" });
  const text = keptNoteText({ ...moved, subject: "Plan" });
  expect(text).toStartWith(
    'Sam changed "Plan" while you were offline, so your words are in a new draft beside it.',
  );
  expect(text).toContain("2 attached files (alpha.pdf, beta.pdf)");
});

test("the same person elsewhere is told the same thing, without a name", () => {
  const nothing = { files: [], quote: false, reply: false };
  expect(
    keptNoteText({ subject: "", leftOut: nothing, changed: { by: null } }),
  ).toBe(
    "A draft was changed on another device or tab while you were offline, so your words are in a new draft beside it.",
  );
  expect(
    keptNoteText({ subject: "", leftOut: nothing, changed: { by: "Sam" } }),
  ).toBe(
    "Sam changed a draft while you were offline, so your words are in a new draft beside it.",
  );
});

test("a copy already sent means the words went with it", async () => {
  const moved = (await moveToDrafts(keptForward, async (copyId) => ({
    status: "copied",
    copyId,
    copyIsDraft: false,
    changed: { by: "Sam" },
  })))!;
  expect(isLeftOut(moved.leftOut)).toBe(false);
  expect(moved.changed).toBeNull();
});

test("trying again for the same kept words reaches the same new draft", async () => {
  const first = await keptCopyId(keptForward.id, 7);
  expect(await keptCopyId(keptForward.id, 7)).toBe(first);
  expect(await keptCopyId(keptForward.id, 8)).not.toBe(first);
  expect(parseOutgoingId(first)).toBe(first);
});

test("a draft removed elsewhere reports the files and quote it can no longer have", async () => {
  const { savedAs, leftOut } = (await moveToDrafts(keptForward, async () =>
    savedHolding({
      attachmentIds: [],
      carriedFrom: [],
      quote: false,
      threaded: false,
    }),
  ))!;
  expect(savedAs).toBe(keptForward.id);
  const text = leftOutText(leftOut);
  expect(text).toContain("2 attached files (alpha.pdf, beta.pdf)");
  expect(text).toContain("the original message");
  expect(text).toContain("Attach the files again");
});

test("one file removed elsewhere is the only one reported", () => {
  const leftOut = leftOutOf(
    { ...keptForward, includeQuote: true },
    { attachmentIds: [2], carriedFrom: [], quote: true, threaded: true },
  );
  expect(leftOut).toEqual({ files: ["alpha.pdf"], quote: false, reply: false });
  expect(leftOutText(leftOut)).toContain("the attached file alpha.pdf");
});

test("a quote the person left out isn't reported as lost", () => {
  const leftOut = leftOutOf(
    { ...keptForward, includeQuote: false },
    { attachmentIds: [1, 2], carriedFrom: [], quote: false, threaded: true },
  );
  expect(isLeftOut(leftOut)).toBe(false);
});

test("a reply that lost its conversation says it will go as a new message", () => {
  const leftOut = leftOutOf(
    { ...keptForward, mode: "reply", attachments: [], includeQuote: false },
    { attachmentIds: [], carriedFrom: [], quote: false, threaded: false },
  );
  expect(leftOut.reply).toBe(true);
  expect(leftOutText(leftOut)).toContain("not as a reply");
});

test("a kept draft that can't reach the server isn't reported as moved", async () => {
  await expect(
    moveToDrafts(keptDraft, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
});

test("a row read from the device is checked like a request", () => {
  expect(parseKeptDraft(keptForward)).toEqual(keptForward);
  for (const broken of [
    null,
    "words",
    { ...keptForward, id: "../other" },
    { ...keptForward, keptAt: "soon" },
    { ...keptForward, mode: "everyone" },
    { ...keptForward, attachments: 7 },
    { ...keptForward, attachments: [{ id: "1" }] },
    { ...keptForward, quote: { bytes: "big" } },
    { ...keptForward, quoteHtml: 1 },
    { ...keptForward, parent: { messageId: "x" } },
    { ...keptForward, content: "text" },
    { ...keptForward, content: { ...keptForward.content, to: "a@b" } },
    { ...keptForward, content: { ...keptForward.content, html: 3 } },
  ]) {
    expect(parseKeptDraft(broken)).toBeNull();
  }
});

test("a note read from the device is checked too", () => {
  const note = {
    id: keptForward.id,
    mailboxId: MAILBOX_A,
    subject: "Words",
    leftOut: { files: ["a"], quote: true, reply: false },
    changed: { by: "Sam" },
  };
  expect(parseKeptNote(note)).toEqual(note as KeptNote);
  expect(parseKeptNote({ ...note, changed: null })).not.toBeNull();
  expect(parseKeptNote({ ...note, changed: { by: 3 } })).toBeNull();
  expect(
    parseKeptNote({
      ...note,
      leftOut: { files: [1], quote: true, reply: false },
    }),
  ).toBeNull();
  expect(parseKeptNote({ ...note, id: "nope" })).toBeNull();
});

test("only words from a mailbox missing from the server's list count as out of reach", () => {
  const drafts = [keptForward];
  expect(withoutAccess(drafts, undefined)).toEqual([]);
  expect(withoutAccess(drafts, [{ id: MAILBOX_A }])).toEqual([]);
  expect(withoutAccess(drafts, [{ id: MAILBOX_B }])).toEqual(drafts);
  expect(withoutAccess(drafts, [])).toEqual(drafts);
});

test("the copy someone can take from a lost mailbox is plain and complete", () => {
  const text = keptAsText(
    {
      ...keptDraft,
      content: {
        ...keptDraft.content,
        to: [{ name: "Pat", address: "pat@example.org" }],
        cc: [{ name: "", address: "cc@example.org" }],
      },
    },
    "Written on a train",
  );
  expect(text).toBe(
    "To: pat@example.org\nCc: cc@example.org\nSubject: Words\n\nWritten on a train",
  );
});

test("links in a device's copy keep to the schemes the sanitizer allows", () => {
  expect(isEditorLink("https://example.org/a")).toBe(true);
  expect(isEditorLink("mailto:a@example.org")).toBe(true);
  expect(isEditorLink("javascript:alert(1)")).toBe(false);
  expect(isEditorLink(" JaVaScRiPt:alert(1)")).toBe(false);
  expect(isEditorLink("data:text/html,x")).toBe(false);
  expect(isEditorLink("/relative")).toBe(false);
});

test("the From check accepts this mailbox's addresses and refuses any other", async () => {
  const { d1 } = createTestDatabase();
  const db = drizzle(d1);
  await db.insert(domains).values({ name: "example.com", isPrimary: true });
  await db.insert(mailboxes).values([
    { id: MAILBOX_A, kind: "shared", name: "Support" },
    { id: MAILBOX_B, kind: "personal", name: "Sam" },
  ]);
  await db.insert(addresses).values([
    {
      address: "support@example.com",
      domain: "example.com",
      mailboxId: MAILBOX_A,
      kind: "primary",
    },
    {
      address: "help@example.com",
      domain: "example.com",
      mailboxId: MAILBOX_A,
      kind: "alias",
    },
    {
      address: "sam@example.com",
      domain: "example.com",
      mailboxId: MAILBOX_B,
      kind: "primary",
    },
  ]);
  const check = (mailbox: MailboxId, from: string) =>
    refuseSenderOutsideMailbox(d1, mailbox, from);

  expect((await check(MAILBOX_A, "HELP@example.com")).name).toBe("Support");
  const facts = await mailboxSenderFacts(d1, MAILBOX_A);
  expect(facts.addresses.map(({ address }) => address)).toEqual([
    "support@example.com",
    "help@example.com",
  ]);

  for (const from of [
    "sam@example.com",
    "nobody@example.com",
    "support@example.com\r\nBcc: x@y.z",
    "",
  ]) {
    const refusal = await check(MAILBOX_A, from).catch((error) => error);
    expect(refusal).toBeInstanceOf(Response);
    expect((refusal as Response).status).toBe(403);
  }
});

test("each kind of send error leads to the right outcome", () => {
  const coded = (code: string) => Object.assign(new Error("x"), { code });
  expect(judgeSendError(coded("E_SENDER_NOT_VERIFIED"))).toEqual({
    kind: "rejected",
    failure: "senderNotVerified",
  });
  expect(judgeSendError(coded("E_DAILY_LIMIT_EXCEEDED"))).toEqual({
    kind: "rejected",
    failure: "dailyLimit",
  });
  expect(judgeSendError(coded("E_RATE_LIMIT_EXCEEDED"))).toEqual({
    kind: "temporary",
  });
  for (const unclear of [
    coded("E_INTERNAL_SERVER_ERROR"),
    coded("E_SOMETHING_NEW"),
    coded("constructor"),
    new Error("Network connection lost."),
    null,
    "boom",
  ]) {
    expect(judgeSendError(unclear)).toEqual({ kind: "ambiguous" });
  }
});

test("threading copies only plain ids from a stranger's message", () => {
  const headers = threadingHeaders(
    {
      rfcMessageId: "parent@x.org",
      references: ["root@x.org", "bad\u0000id@x.org", "bad>id", "parent@x.org"],
    },
    "own@x.org",
  );
  expect(headers).toEqual({
    "In-Reply-To": "<parent@x.org>",
    References: "<root@x.org> <parent@x.org>",
  });
  expect(
    threadingHeaders(
      { rfcMessageId: "bad\r\nid", references: [] },
      "own@x.org",
    ),
  ).toEqual({ References: "<own@x.org>" });
  expect(threadingHeaders(null, "own@x.org")).toEqual({
    References: "<own@x.org>",
  });
});

test("the stored copy's id handles any shape of returned value", () => {
  expect(storedMessageId("<a@b>", "own@x")).toBe("a@b");
  expect(storedMessageId("token-123", "own@x")).toBe("token-123");
  expect(storedMessageId("", "own@x")).toBe("own@x");
  expect(storedMessageId(undefined, "own@x")).toBe("own@x");
  expect(storedMessageId("bad value\r\nX: y", "own@x")).toBe("own@x");
});

test("replying to our own sent message goes on to the same people", () => {
  const own = ["me@x.org"];
  const sentByUs = {
    from: person("me@x.org"),
    replyTo: [],
    to: [person("pat@y.org")],
    cc: [person("kim@y.org")],
  };
  expect(replyRecipients(sentByUs, "reply", own)).toEqual({
    to: [person("pat@y.org")],
    cc: [],
  });
  expect(replyRecipients(sentByUs, "replyAll", own)).toEqual({
    to: [person("pat@y.org")],
    cc: [person("kim@y.org")],
  });
});

test("reply uses Reply-To when it is there, and repeats no one", () => {
  const parent = {
    from: person("list@y.org"),
    replyTo: [person("pat@y.org")],
    to: [person("me@x.org"), person("PAT@y.org")],
    cc: [person("kim@y.org"), person("kim@y.org")],
  };
  const all = replyRecipients(parent, "replyAll", ["me@x.org"]);
  expect(all.to).toEqual([person("pat@y.org")]);
  expect(all.cc).toEqual([person("kim@y.org")]);
});

test("subjects gain one prefix, and the From is the address the message reached", () => {
  expect(composeSubject("Hello", "reply")).toBe("Re: Hello");
  expect(composeSubject("RE: Hello", "replyAll")).toBe("RE: Hello");
  expect(composeSubject("Hello", "forward")).toBe("Fwd: Hello");
  expect(composeSubject("Fwd: Hello", "forward")).toBe("Fwd: Hello");
  expect(composeSubject(null, "reply")).toBe("Re:");
  expect(composeSubject("a\r\nBcc: x", "reply")).toBe("Re: a Bcc: x");

  const own = ["main@x.org", "sales@x.org"];
  expect(
    defaultFromAddress(
      {
        envelopeTo: "SALES@x.org",
        to: [person("main@x.org")],
        cc: [],
        from: person("p@y.org"),
      },
      own,
    ),
  ).toBe("sales@x.org");
  expect(defaultFromAddress(null, own)).toBe("main@x.org");
});

test("address checking accepts real addresses and refuses anything that could end a header", () => {
  for (const good of [
    "a@x.org",
    "first.last+tag@sub.example.co.uk",
    "alex@mail-compose.cloudysuite.localhost",
  ]) {
    expect(isValidAddress(good)).toBe(true);
  }
  for (const bad of [
    "",
    "plain",
    "@x.org",
    "a@",
    "a@x",
    "a b@x.org",
    "a@x.org\r\nBcc: e@x.org",
    "a@x.org\n",
    "a<b>@x.org",
    "a..b@x.org",
    ".a@x.org",
    "a@-x.org",
    "ä@x.org",
  ]) {
    expect(isValidAddress(bad)).toBe(false);
  }
});

test("typed or pasted address lists split the way a person means them", () => {
  expect(
    parseAddressList(
      'a@x.org, Bo Lee <b@x.org>; "Lee, Cy" <c@x.org>\nd@x.org,,',
    ),
  ).toEqual([
    { name: "", address: "a@x.org" },
    { name: "Bo Lee", address: "b@x.org" },
    { name: "Lee, Cy", address: "c@x.org" },
    { name: "", address: "d@x.org" },
  ]);
});

test("a quoted full document loses its outer tags, in both parts", async () => {
  const quote = await buildQuote(
    {
      from: person("p@y.org"),
      to: [],
      cc: [],
      subject: "Hi",
      sentAt: 0,
      receivedAt: 0,
    } as unknown as MessageDetail,
    {
      text: null,
      html: "<!doctype html><html><head><style>p{margin:0}</style></head><body><p>Words</p></body></html>",
    },
    "reply",
    "example.com",
  );
  expect(quote.html).not.toMatch(/doctype|<html|<head|<body/i);
  expect(quote.html).toContain("<p>Words</p>");
  expect(quote.text).toContain("> Words");
  expect(quote.text).not.toMatch(/doctype|margin/i);
});

test("the plain-text part keeps lists, links, and line breaks", () => {
  expect(
    htmlToPlainText(
      '<div>Hello &amp; welcome<br>second</div><p>Para</p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol><a href="https://x.org/">site</a> <a href="mailto:a@x.org">a@x.org</a>',
    ),
  ).toBe(
    "Hello & welcome\nsecond\nPara\n- one\n- two\n1. first\nsite (https://x.org/) a@x.org",
  );
  expect(htmlToPlainText("")).toBe("");
});

test("a link nobody closed keeps all the text after it", () => {
  expect(
    htmlToPlainText(
      '<p>Before <a href="https://x.org/">the link<p>Second paragraph<p>Third paragraph',
    ),
  ).toBe("Before the link (https://x.org/)\nSecond paragraph\nThird paragraph");
  expect(htmlToPlainText('Read <a href="https://x.org/">this and more')).toBe(
    "Read this and more (https://x.org/)",
  );
});

test("a link opened inside another keeps both links' text", () => {
  expect(
    htmlToPlainText(
      '<a href="https://one.org/">first<a href="https://two.org/">second</a> after',
    ),
  ).toBe("first (https://one.org/)second (https://two.org/) after");
});

test("a link around one block still reads as one link", () => {
  expect(htmlToPlainText('<a href="https://x.org/"><div>Open</div></a>')).toBe(
    "Open (https://x.org/)",
  );
});

test("a message that is only an attachment still has a body for the service", () => {
  const message = {
    id: "00000000-0000-4000-8000-000000000001" as OutgoingId,
    from: person("a@example.com"),
    to: [person("b@example.org")],
    cc: [],
    bcc: [],
    subject: "Files",
    parent: null,
    files: [
      { filename: "a.txt", mimeType: "text/plain", bytes: new Uint8Array(1) },
    ],
  };
  const empty = toEmailBuilder({ ...message, html: "", text: "" });
  expect(empty.html).toBe("<br>");
  expect(empty.text).toBeUndefined();
  const written = toEmailBuilder({ ...message, html: "<p>Hi</p>", text: "Hi" });
  expect(written.html).toBe("<p>Hi</p>");
  expect(written.text).toBe("Hi");
});

test("the size limit counts a quote's plain text and a long plain-text part", () => {
  const near = 18 * 1024 * 1024;
  const fits = (bodyBytes: number, quoteBytes: number) =>
    fitsSendLimit({ bodyBytes, quoteBytes, attachmentSizes: [near] });
  expect(fits(0, 0)).toBe(true);
  // A small HTML part beside 2 MB of plain text in the original.
  expect(fits(0, 2 * 1024 * 1024)).toBe(false);
  const deepList = `${"<ul>".repeat(400)}${"<li>".repeat(4000)}`;
  const text = htmlToPlainText(deepList);
  expect(text.length).toBeGreaterThan(deepList.length);
  expect(writtenBytes(deepList, text)).toBe(text.length);
});

test("a recipient's chip can't hide the real address behind a name that looks like one", () => {
  const real = "mallory@evil.test";
  for (const name of [
    "ceo@company.com",
    "CEO <ceo@company.com>",
    "ceo\uFF20company.com",
    "ceo\uFE6Bcompany.com",
  ]) {
    expect(recipientLabel(person(real, name))).toBe(real);
  }
  expect(recipientLabel(person(real, "Mallory Doe"))).toBe("Mallory Doe");
  expect(recipientLabel(person(real))).toBe(real);
});

const discardFrom = (uploads: Promise<unknown>[], rowAfter: () => boolean) => {
  const discarded: string[] = [];
  const running = discardWhenSettled({
    uploads: new Set(uploads),
    saving: Promise.resolve(),
    hasRow: rowAfter,
    discard: async () => discarded.push("discarded"),
  });
  return { discarded, running };
};

test("a discard waits for a file on its way, then removes the row it made", async () => {
  const upload = Promise.withResolvers<void>();
  let row = false;
  const { discarded, running } = discardFrom([upload.promise], () => row);
  await Bun.sleep(0);
  expect(discarded).toEqual([]);
  row = true;
  upload.resolve();
  await running;
  expect(discarded).toEqual(["discarded"]);
});

test("a discard still asks after a failed upload, which may have landed", async () => {
  const { discarded, running } = discardFrom([Promise.resolve()], () => false);
  await running;
  expect(discarded).toEqual(["discarded"]);
});

test("a discard asks nothing when no row exists and no file is on its way", async () => {
  const { discarded, running } = discardFrom([], () => false);
  await running;
  expect(discarded).toEqual([]);
});

test("a discard waits for a first save still on its way", async () => {
  const save = Promise.withResolvers<void>();
  let row = false;
  const discarded: string[] = [];
  const running = discardWhenSettled({
    uploads: new Set(),
    saving: save.promise,
    hasRow: () => row,
    discard: async () => discarded.push("discarded"),
  });
  await Bun.sleep(0);
  row = true;
  save.resolve();
  await running;
  expect(discarded).toEqual(["discarded"]);
});
