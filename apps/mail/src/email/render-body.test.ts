import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { checkMailboxAccess } from "@cloudysuite/access";
import type { UserId } from "../../../../src/db/schema";
import { createTestDatabase } from "../../../../src/db/test-database";
import { openMailbox } from "../client";
import { ingest } from "../ingest";
import { createTestEnv, MAILBOX_A, toArrayBuffer } from "../test-support";
import type { MessageId } from "../types";
import { renderBody } from "./render-body";

const fromHex = (hex: string) => Buffer.from(hex, "hex").toString("base64");
const PNG_BASE64 = fromHex("89504e470d0a1a0a0000");
const JPEG_BASE64 = fromHex("ffd8ffe000104a464946");
const GIF_BASE64 = fromHex("474946383961010001");
const WEBP_BASE64 = fromHex("52494646240000005745425056503820");
const DOMAIN = "suite.example.com";
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

const relatedMail = (type: string, html: string, content = PNG_BASE64) => [
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
  content,
  "--b--",
];

test("a picture the message uses is embedded and leaves the attachment list", async () => {
  const { mailbox, deliver } = await setUp();
  const id = await deliver(relatedMail("image/png", `<img src="cid:logo@x">`));
  const body = await renderBody(mailbox, id, DOMAIN);
  if (body?.kind !== "html") throw new Error("expected html");
  expect(body.html).toContain(`data:image/png;base64,${PNG_BASE64}`);
  expect(body.embedded).toHaveLength(1);
});

test("each picture format is embedded when its bytes agree", async () => {
  const { mailbox, deliver } = await setUp();
  for (const [type, content] of [
    ["image/png", PNG_BASE64],
    ["IMAGE/JPEG", JPEG_BASE64],
    ["image/gif", GIF_BASE64],
    ["image/webp", WEBP_BASE64],
  ] as const) {
    const id = await deliver(
      relatedMail(type, `<img src="cid:logo@x">`, content),
    );
    const body = await renderBody(mailbox, id, DOMAIN);
    if (body?.kind !== "html") throw new Error("expected html");
    expect(body.html).toContain(`data:${type.toLowerCase()};base64,${content}`);
    expect(body.embedded).toHaveLength(1);
  }
});

test("a file that lies about being a picture stays an attachment", async () => {
  const { mailbox, deliver } = await setUp();
  for (const [type, content] of [
    ["image/png", btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")],
    ["image/png", JPEG_BASE64],
    ["image/jpeg", PNG_BASE64],
    ["image/gif", fromHex("474946383861")],
    ["image/gif", fromHex("474946")],
    ["image/webp", fromHex("524946462400000041564920")],
    ["image/png", ""],
  ] as const) {
    const id = await deliver(
      relatedMail(type, `<img src="cid:logo@x" alt="a">`, content),
    );
    const body = await renderBody(mailbox, id, DOMAIN);
    if (body?.kind !== "html") throw new Error("expected html");
    expect(body.html).toContain(`<img alt="a">`);
    expect(body.embedded).toEqual([]);
  }
});

test("an inline file that could hold script is never embedded", async () => {
  const { mailbox, deliver } = await setUp();
  for (const type of ["image/svg+xml", "text/html"]) {
    const id = await deliver(relatedMail(type, `<img src="cid:logo@x">`));
    const body = await renderBody(mailbox, id, DOMAIN);
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
  const body = await renderBody(mailbox, id, DOMAIN);
  if (body?.kind !== "html") throw new Error("expected html");
  expect(body.html.trim()).toBe("<p>Hi</p>");
});

test("plain text stays plain, and an empty message says so", async () => {
  const { mailbox, deliver } = await setUp();
  const text = await deliver(["Content-Type: text/plain", "", "<b>Hello</b>"]);
  const plain = await renderBody(mailbox, text, DOMAIN);
  if (plain?.kind !== "text") throw new Error("expected text");
  expect(plain.text.trim()).toBe("<b>Hello</b>");
  const empty = await deliver(["Content-Type: text/plain", "", ""]);
  expect(await renderBody(mailbox, empty, DOMAIN)).toEqual({ kind: "empty" });
  expect(await renderBody(mailbox, 999 as MessageId, DOMAIN)).toBeNull();
});

test("a body too long to show does not reach the browser", async () => {
  const { mailbox, deliver } = await setUp();
  const long = "x".repeat(2_100_000);
  const onlyHtml = await deliver([
    "Content-Type: text/html",
    "",
    `<p>${long}</p>`,
  ]);
  expect(await renderBody(mailbox, onlyHtml, DOMAIN)).toEqual({
    kind: "tooLong",
  });
  const onlyText = await deliver(["Content-Type: text/plain", "", long]);
  expect(await renderBody(mailbox, onlyText, DOMAIN)).toEqual({
    kind: "tooLong",
  });
});
