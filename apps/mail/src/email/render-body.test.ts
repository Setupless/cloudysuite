import { expect, test } from "bun:test";
import { checkMailboxAccess } from "@cloudysuite/access";
import type { UserId } from "../../../../src/db/schema";
import { createTestDatabase } from "../../../../src/db/test-database";
import { openMailbox } from "../client";
import { ingest } from "../ingest";
import { createTestEnv, MAILBOX_A, toArrayBuffer } from "../test-support";
import type { MessageId } from "../types";
import { renderBody } from "./render-body";

const PNG_BASE64 = "AAEC";
const alice = "user-alice" as UserId;

async function setUp() {
  const { sqlite, d1 } = createTestDatabase();
  sqlite.run(
    "INSERT INTO user (id, name, email) VALUES (?, 'Alice', 'a@x.org')",
    [alice],
  );
  sqlite.run(
    "INSERT INTO mailboxes (id, kind, name) VALUES (?, 'shared', 'x')",
    [MAILBOX_A],
  );
  sqlite.run(
    "INSERT INTO mailbox_access (mailbox_id, user_id, role) VALUES (?, ?, 'member')",
    [MAILBOX_A, alice],
  );
  const access = await checkMailboxAccess(d1, alice, MAILBOX_A);
  if (!access.allowed) throw new Error("expected access");
  const { env } = createTestEnv();
  const mailbox = openMailbox(env, access.grant);

  const deliver = async (lines: string[]) => {
    const raw = toArrayBuffer(
      [
        "From: a@example.org",
        "Subject: Hello",
        "Message-ID: <" + crypto.randomUUID() + "@x>",
        ...lines,
      ].join("\r\n"),
    );
    const result = await ingest(env, {
      source: "inbound",
      mailboxId: MAILBOX_A,
      raw,
      envelope: { from: "a@x.org", to: "b@x.org" },
    });
    if (result.status === "tooLarge") throw new Error("too large");
    return result.messageId;
  };
  return { mailbox, deliver };
}

const relatedMail = (type: string, html: string) => [
  'Content-Type: multipart/related; boundary="b"',
  "",
  "--b",
  "Content-Type: text/html",
  "",
  html,
  "--b",
  `Content-Type: ${type}`,
  "Content-Transfer-Encoding: base64",
  "Content-ID: <logo@x>",
  "Content-Disposition: inline",
  "",
  PNG_BASE64,
  "--b--",
];

test("a picture the message uses is embedded and leaves the attachment list", async () => {
  const { mailbox, deliver } = await setUp();
  const id = await deliver(relatedMail("image/png", `<img src="cid:logo@x">`));
  const body = await renderBody(mailbox, id);
  if (body?.kind !== "html") throw new Error("expected html");
  expect(body.html).toContain(`data:image/png;base64,${PNG_BASE64}`);
  expect(body.embedded).toHaveLength(1);
});

test("an inline file that could hold script is never embedded", async () => {
  const { mailbox, deliver } = await setUp();
  for (const type of ["image/svg+xml", "text/html"]) {
    const id = await deliver(relatedMail(type, `<img src="cid:logo@x">`));
    const body = await renderBody(mailbox, id);
    if (body?.kind !== "html") throw new Error("expected html");
    expect(body.html).not.toContain("data:");
    expect(body.embedded).toEqual([]);
  }
});

test("hostile HTML reaches the browser only after cleaning", async () => {
  const { mailbox, deliver } = await setUp();
  const id = await deliver([
    "Content-Type: text/html",
    "",
    `<p onclick="x">Hi</p><script>alert(1)</script>`,
  ]);
  const body = await renderBody(mailbox, id);
  if (body?.kind !== "html") throw new Error("expected html");
  expect(body.html.trim()).toBe("<p>Hi</p>");
});

test("plain text stays plain, and an empty message says so", async () => {
  const { mailbox, deliver } = await setUp();
  const text = await deliver(["Content-Type: text/plain", "", "<b>Hello</b>"]);
  const plain = await renderBody(mailbox, text);
  if (plain?.kind !== "text") throw new Error("expected text");
  expect(plain.text.trim()).toBe("<b>Hello</b>");
  const empty = await deliver(["Content-Type: text/plain", "", ""]);
  expect(await renderBody(mailbox, empty)).toEqual({ kind: "empty" });
  expect(await renderBody(mailbox, 999 as MessageId)).toBeNull();
});

test("a body too long to show does not reach the browser", async () => {
  const { mailbox, deliver } = await setUp();
  const long = "x".repeat(2_100_000);
  const onlyHtml = await deliver([
    "Content-Type: text/html",
    "",
    `<p>${long}</p>`,
  ]);
  expect(await renderBody(mailbox, onlyHtml)).toEqual({ kind: "tooLong" });
  const onlyText = await deliver(["Content-Type: text/plain", "", long]);
  expect(await renderBody(mailbox, onlyText)).toEqual({ kind: "tooLong" });
});
