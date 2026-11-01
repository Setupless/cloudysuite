import { expect, test } from "bun:test";
import type { MailboxId } from "@cloudysuite/access";
import { createTestDatabase } from "../../../../src/db/test-database";
import { addresses, domains, mailboxes } from "../../../../src/db/schema";
import { MAILBOX_A, MAILBOX_B } from "../test-support";
import { recipientLabel } from "../ui/format";
import type { MessageDetail } from "../types";
import { drizzle } from "drizzle-orm/d1";
import { buildQuote, htmlToPlainText } from "./body";
import { mailboxSenderFacts, refuseSenderOutsideMailbox } from "./addresses";
import { replyRecipients, composeSubject, defaultFromAddress } from "./reply";
import { judgeSendError } from "./send-outcome";
import { storedMessageId, threadingHeaders } from "./threading-headers";
import { isValidAddress, parseAddressList } from "./validate";

const person = (address: string, name = "") => ({ name, address });

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
