import { expect, test } from "bun:test";
import {
  htmlToSearchText,
  PARSE_LIMITS,
  parseMessage,
  readableText,
  snippetOf,
  truncateUtf8,
} from "./parse";
import { toArrayBuffer } from "./test-support";

const parse = (text: string) => parseMessage(toArrayBuffer(text));

test("reads the fields of a plain message", async () => {
  const message = await parse(
    [
      'From: "Alice A" <alice@example.org>',
      "To: bob@example.com, Team: c@example.com, d@example.com;",
      "Cc: e@example.com",
      "Reply-To: replies@example.org",
      "Subject: =?utf-8?q?caf=C3=A9?=",
      "Date: Mon, 02 Nov 2026 10:00:00 +0000",
      "Message-ID: <one@example.org>",
      "In-Reply-To: <parent@example.org>",
      "References: <root@example.org> <parent@example.org>",
      "",
      "Body text",
    ].join("\r\n"),
  );
  expect(message).toMatchObject({
    status: "parsed",
    rfcMessageId: "one@example.org",
    references: ["root@example.org", "parent@example.org"],
    subject: "café",
    from: { name: "Alice A", address: "alice@example.org" },
    replyTo: [{ name: "", address: "replies@example.org" }],
    to: [
      { name: "", address: "bob@example.com" },
      { name: "", address: "c@example.com" },
      { name: "", address: "d@example.com" },
    ],
    cc: [{ name: "", address: "e@example.com" }],
    sentAt: Date.UTC(2026, 10, 2, 10),
    html: null,
    attachments: [],
  });
  expect(message.text?.trim()).toBe("Body text");
});

test("an invalid date is no date, and missing headers are empty", async () => {
  expect(await parse("Date: yesterday-ish\r\n\r\nhi")).toMatchObject({
    status: "parsed",
    sentAt: null,
    subject: null,
    from: null,
    rfcMessageId: null,
    references: [],
    to: [],
  });
});

test("a message of only HTML still gets readable text", async () => {
  const message = await parse(
    'Content-Type: text/html\r\n\r\n<html><head><title>no</title><style>p{}</style></head><p>Hello &amp; <b>welcome</b></p><script>alert("no")</script>',
  );
  expect(message.text).toBeNull();
  expect(snippetOf(readableText(message))).toBe("Hello & welcome");
});

test("a file name cannot carry a quote or control character into a download header", async () => {
  for (const [header, expected] of [
    ['filename="a\\"; evil=\\"b.pdf"', "a; evil=b.pdf"],
    ["filename*=UTF-8\'\'it%27s%22%07.pdf", "its.pdf"],
  ] as const) {
    const message = await parse(
      [
        "From: a@example.org",
        "Content-Type: multipart/mixed; boundary=b",
        "",
        "--b",
        "Content-Type: application/pdf",
        `Content-Disposition: attachment; ${header}`,
        "",
        "payload",
        "--b--",
      ].join("\r\n"),
    );
    expect(message.attachments[0]?.filename).toBe(expected);
  }
});

test("attachment details from a hostile sender are cleaned", async () => {
  const message = await parse(
    [
      "Content-Type: multipart/mixed; boundary=b",
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "hi",
      "--b",
      "Content-Type: ../../evil/type",
      'Content-Disposition: attachment; filename="../../etc/‮passwd\u0007.txt"',
      "Content-ID: <  bad id >",
      "",
      "payload",
      "--b",
      "Content-Type: image/png",
      "Content-Disposition: inline",
      "Content-ID: <logo@x>",
      "Content-Transfer-Encoding: base64",
      "",
      "AAEC",
      "--b--",
    ].join("\r\n"),
  );
  const [hostile, image] = message.attachments;
  expect(hostile?.filename).toBe(".._.._etc__passwd.txt");
  expect(hostile?.mimeType).toBe("application/octet-stream");
  expect(hostile?.contentId).toBeNull();
  expect(hostile?.inline).toBe(false);
  expect(image).toMatchObject({
    mimeType: "image/png",
    inline: true,
    contentId: "logo@x",
  });
  expect(image?.content.byteLength).toBe(3);
});

function expectStoredAsFailed(message: Awaited<ReturnType<typeof parse>>) {
  expect(message.status).toBe("failed");
  expect(message.subject).toBe("Bomb");
  expect(message.from?.address).toBe("eve@example.org");
  expect(message.rfcMessageId).toBe("bomb@example.org");
  expect(message.attachments).toEqual([]);
  expect(message.text?.length).toBeGreaterThan(0);
}

const bombHeaders = [
  "From: Eve <eve@example.org>",
  "Subject: Bomb",
  "Message-ID: <bomb@example.org>",
];

test("a message nested past the limit falls back to its readable parts", async () => {
  const depth = PARSE_LIMITS.maxNestingDepth + 5;
  let body = "deep";
  for (let index = depth; index > 0; index -= 1) {
    body = `--b${index}\r\nContent-Type: multipart/mixed; boundary=b${index + 1}\r\n\r\n${body}\r\n--b${index}--`;
  }
  expectStoredAsFailed(
    await parse(
      [
        ...bombHeaders,
        "Content-Type: multipart/mixed; boundary=b1",
        "",
        body,
      ].join("\r\n"),
    ),
  );
});

test("a message with too many parts falls back to its readable parts", async () => {
  const parts = "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n".repeat(
    PARSE_LIMITS.maxPartCount + 5,
  );
  expectStoredAsFailed(
    await parse(
      [
        ...bombHeaders,
        "Content-Type: multipart/mixed; boundary=b",
        "",
        parts,
      ].join("\r\n"),
    ),
  );
});

test("a message with oversized headers falls back to its readable parts", async () => {
  expectStoredAsFailed(
    await parse(
      [
        ...bombHeaders,
        ...Array.from(
          { length: 5000 },
          (_, index) => `X-Filler-${index}: ${"y".repeat(100)}`,
        ),
        "",
        "the body",
      ].join("\r\n"),
    ),
  );
});

test("binary junk and an empty message parse without throwing", async () => {
  const junk = new Uint8Array(4096).map((_, index) => (index * 37) % 256);
  const parsed = await parseMessage(junk.buffer as ArrayBuffer);
  expect(parsed.attachments).toEqual([]);
  expect(typeof readableText(parsed)).toBe("string");
  expect(readableText(parsed)).not.toContain("\u0000");

  const empty = await parseMessage(new ArrayBuffer(0));
  expect(empty.subject).toBeNull();
});

test("control characters do not reach a subject, a name, or a snippet", async () => {
  const message = await parse(
    'Subject: one\u0000two\u0007three\r\nFrom: "Eve\u0001 E" <eve@x.org>\r\n\r\nb\u0000o\u001fdy',
  );
  expect(message.subject).toBe("one two three");
  expect(message.from?.name).toBe("Eve E");
  expect(snippetOf("b\u0000o\u001fdy\n\nnext")).toBe("b o dy next");
});

test("the number of addresses kept per field is limited", async () => {
  const many = Array.from({ length: 2000 }, (_, i) => `u${i}@x.org`).join(", ");
  const message = await parse(`To: ${many}\r\n\r\nhi`);
  expect(message.to).toHaveLength(500);
});

test.each([
  ["<p>a</p><p>b</p>", "a  b"],
  ["a < b", "a "],
  ["<script>never closed", ""],
  ["<scripty>keep</scripty>", "keep"],
  ["one&#33;&#x21;&bogus;", "one!!&bogus;"],
  ["<STYLE>x</STYLE>shown", "shown"],
])("htmlToSearchText(%j)", (html, expected) => {
  expect(htmlToSearchText(html).trim()).toBe(expected.trim());
});

test("hostile markup does not take quadratic time", () => {
  const started = performance.now();
  htmlToSearchText("<script ".repeat(400_000));
  htmlToSearchText("<a ".repeat(1_000_000));
  htmlToSearchText("<style></style>".repeat(200_000));
  expect(performance.now() - started).toBeLessThan(2000);
});

test("truncating never splits a character", () => {
  const text = "é".repeat(10);
  expect(truncateUtf8(text, 5)).toBe("éé");
  expect(truncateUtf8("short", 100)).toBe("short");
  expect(truncateUtf8("😀😀", 5)).toBe("😀");
});
