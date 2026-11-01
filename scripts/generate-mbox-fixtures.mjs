// Writes .mbox files for testing Mail import by hand, and an expected.json that says
// what each should produce. The same seed gives the same bytes on every run.
// Usage: bun scripts/generate-mbox-fixtures.mjs <output directory>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) {
  console.error(
    "Usage: bun scripts/generate-mbox-fixtures.mjs <output directory>",
  );
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

function randomFrom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE = [
  ["Priya Raman", "priya@northwind.example"],
  ["Tomás Herrera", "tomas@northwind.example"],
  ["Ana Kowalska", "ana.kowalska@example.org"],
  ["Sam Lee", "sam@acme.example"],
  ["Billing", "billing@saas.example"],
  ["Noor Hadid", "noor@example.net"],
];
const ME = ["Mina Park", "mina@cloudysuite.example"];
const TOPICS = [
  "Quarterly planning",
  "Invoice 2291",
  "Lunch on Thursday",
  "Office move",
  "Déjà vu in the logs",
  "Contract renewal",
  "Team offsite",
  "Printer on level 3",
];
const WORDS =
  "the plan looks good but we should check numbers before friday because the client asked about timing and budget again please send notes when you can".split(
    " ",
  );
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

const pad = (value) => String(value).padStart(2, "0");
const rfc2822 = (date) =>
  `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
const takeoutDate = (date) =>
  `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000 ${date.getUTCFullYear()}`;
const encodedWord = (text) =>
  `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
const address = ([name, email]) =>
  /^[\x20-\x7e]*$/.test(name)
    ? `${name} <${email}>`
    : `${encodedWord(name)} <${email}>`;

function sentence(random, count) {
  const words = [];
  for (let i = 0; i < count; i += 1) {
    words.push(WORDS[Math.floor(random() * WORDS.length)]);
  }
  return words.join(" ");
}

function wrappedBase64(bytes) {
  return (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}

function randomBytes(random, size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = Math.floor(random() * 256);
  return bytes;
}

// What Google Takeout writes, as best known: a numeric separator, its own headers
// first, and CRLF inside the message. Not checked against a real export.
function takeoutMessage({
  random,
  threadId,
  id,
  references,
  from,
  to,
  subject,
  date,
  text,
  attachmentBytes = 0,
}) {
  const headers = [
    `From ${threadId}@xxx ${takeoutDate(date)}`,
    `X-GM-THRID: ${threadId}`,
    "X-Gmail-Labels: Archived,Important",
    "MIME-Version: 1.0",
    `Message-ID: <${id}>`,
    ...(references.length > 0
      ? [
          `In-Reply-To: <${references.at(-1)}>`,
          `References: ${references.map((ref) => `<${ref}>`).join(" ")}`,
        ]
      : []),
    `Date: ${rfc2822(date)}`,
    `From: ${address(from)}`,
    `To: ${address(to)}`,
    `Subject: ${/^[\x20-\x7e]*$/.test(subject) ? subject : encodedWord(subject)}`,
  ];
  const boundary = `b-${id.split("@")[0]}`;
  const html = `<p>${text}</p>`;
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
    "--alt",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
    "--alt--",
  ];
  if (attachmentBytes > 0) {
    lines.push(
      `--${boundary}`,
      'Content-Type: application/pdf; name="notes.pdf"',
      'Content-Disposition: attachment; filename="notes.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      wrappedBase64(randomBytes(random, attachmentBytes)),
    );
  }
  lines.push(`--${boundary}--`, "", "");
  return lines.join("\r\n");
}

function conversationFile({ seed, messages, attachmentBytes = () => 0 }) {
  const random = randomFrom(seed);
  const parts = [];
  let written = 0;
  let threads = 0;
  const words = [];
  let dateBase = Date.UTC(2017, 2, 4, 9);
  while (written < messages) {
    threads += 1;
    const threadId = 1500000000000000000n + BigInt(threads) * 7919n;
    const topic = TOPICS[Math.floor(random() * TOPICS.length)];
    const subject = `${topic} ${threads}`;
    const length = Math.min(1 + Math.floor(random() * 6), messages - written);
    const person = PEOPLE[Math.floor(random() * PEOPLE.length)];
    const references = [];
    for (let i = 0; i < length; i += 1) {
      const id = `s${seed}-t${threads}-m${i}@mail.example`;
      const date = new Date(dateBase);
      dateBase += Math.floor(random() * 3 * 86_400_000);
      const unique = `tracer${seed}x${written}`;
      if (written % 100 === 0) words.push(unique);
      parts.push(
        takeoutMessage({
          random,
          threadId,
          id,
          references: [...references],
          from: i % 2 === 0 ? person : ME,
          to: i % 2 === 0 ? ME : person,
          subject: i === 0 ? subject : `Re: ${subject}`,
          date,
          text: `${sentence(random, 10 + Math.floor(random() * 80))} ${unique}`,
          attachmentBytes: attachmentBytes(written),
        }),
      );
      references.push(id);
      written += 1;
    }
  }
  return {
    bytes: Buffer.concat(parts.map((part) => Buffer.from(part, "utf8"))),
    threads,
    words,
    firstDate: Date.UTC(2017, 2, 4, 9),
    lastDate: dateBase,
  };
}

const SEPARATOR = "From alice@example.org Mon Nov  2 10:00:00 2015";
const simple = (subject, body, newline = "\n", id = subject) =>
  [
    `From: Alice <alice@example.org>`,
    "To: Mina <mina@cloudysuite.example>",
    `Subject: ${subject}`,
    `Message-ID: <${id.replaceAll(" ", "-")}@fixture.example>`,
    "Date: Mon, 02 Nov 2015 10:00:00 +0000",
    "",
    body,
    "",
  ].join(newline);
const framed = (subject, body, newline = "\n", id) =>
  `${SEPARATOR}${newline}${simple(subject, body, newline, id)}${newline}`;

const expected = {};
function write(name, bytes, facts) {
  writeFileSync(join(outDir, name), bytes);
  expected[name] = { size: Buffer.byteLength(bytes), ...facts };
}

const thousand = conversationFile({
  seed: 1,
  messages: 1000,
  attachmentBytes: (index) => (index % 25 === 0 ? 40_000 : 0),
});
write("thousand.mbox", thousand.bytes, {
  stored: 1000,
  threads: thousand.threads,
  searchableWords: thousand.words,
  firstDate: thousand.firstDate,
  lastDate: thousand.lastDate,
});

const large = conversationFile({
  seed: 2,
  messages: 120,
  attachmentBytes: (index) => (index % 3 === 0 ? 900_000 : 0),
});
write("large-multipart.mbox", large.bytes, {
  stored: 120,
  threads: large.threads,
  searchableWords: large.words,
});

const scale = conversationFile({ seed: 7, messages: 20_000 });
write("scale-20000.mbox", scale.bytes, {
  stored: 20_000,
  threads: scale.threads,
});

const browser = conversationFile({
  seed: 6,
  messages: 120,
  attachmentBytes: (index) => (index % 3 === 0 ? 900_000 : 0),
});
write("browser-upload.mbox", browser.bytes, {
  stored: 120,
  threads: browser.threads,
});

// Same size as the file above, with different bytes, for picking the wrong file.
const wrong = Buffer.from(browser.bytes);
wrong.fill(0x20, wrong.length - 100);
write("wrong-file.mbox", wrong, { refused: "not the same file" });

const heavy = conversationFile({
  seed: 5,
  messages: 400,
  attachmentBytes: () => 60_000,
});
write("kill-heavy.mbox", heavy.bytes, { stored: 400, threads: heavy.threads });

const resume = conversationFile({ seed: 4, messages: 3000 });
write("resume-3000.mbox", resume.bytes, {
  stored: 3000,
  threads: resume.threads,
  searchableWords: resume.words,
});

write(
  "lf.mbox",
  framed("lf one", "first body") + framed("lf two", "second body"),
  { stored: 2 },
);
write(
  "crlf.mbox",
  framed("crlf one", "first body", "\r\n") +
    framed("crlf two", "second body", "\r\n"),
  { stored: 2 },
);

const escapeBody = [
  ">From escaped once in the file",
  ">>From escaped twice in the file",
  "From the desk of the director, unescaped",
  "From alice@example.org Mon Nov  2 10:00:00 2015",
  "That line above looks like a separator, and no header follows it.",
].join("\n");
write(
  "from-lines.mbox",
  framed("from lines", escapeBody) +
    framed("after from lines", "still separate"),
  {
    stored: 2,
    bodyContains: [
      "\nFrom escaped once in the file",
      "\n>From escaped twice in the file",
      "\nFrom the desk of the director, unescaped",
      "\nFrom alice@example.org Mon Nov  2 10:00:00 2015\n",
    ],
  },
);

// Reads are 1 MiB, so these messages each sit across a boundary at a different point:
// in a body, in a separator, and in the header after a separator.
const READ = 1024 * 1024;
const fill = (subject, targetEnd, soFar) => {
  const overhead = Buffer.byteLength(framed(subject, ""));
  return framed(subject, "b".repeat(targetEnd - soFar - overhead));
};
let boundary = "";
boundary += fill("boundary in the body", READ + 500, 0);
boundary += fill(
  "boundary in the separator",
  2 * READ - 20,
  Buffer.byteLength(boundary),
);
boundary += fill(
  "boundary after the separator",
  3 * READ - SEPARATOR.length - 3,
  Buffer.byteLength(boundary),
);
boundary += framed("last at the boundary", "the end");
write("chunk-boundary.mbox", boundary, { stored: 4 });

write("empty.mbox", "", { refused: 400 });
write("garbage.mbox", Buffer.from(randomBytes(randomFrom(3), 200_000)), {
  state: "failed",
});

const oversizeBody = `${"p".repeat(76)}\r\n`.repeat(
  Math.ceil((26 * 1024 * 1024) / 78),
);
write(
  "oversize-26mib.mbox",
  framed("before the big one", "small") +
    framed("Holiday photos", oversizeBody) +
    framed("after the big one", "small"),
  { stored: 2, unreadable: { reason: "tooLarge", hint: "Holiday photos" } },
);

// A real attachment, base64 encoded, that brings the whole message just under 25 MiB.
const nearLimitHead = [
  "From: Alice <alice@example.org>",
  "To: Mina <mina@cloudysuite.example>",
  "Subject: Nearly at the limit",
  "Message-ID: <near-limit@fixture.example>",
  "Date: Mon, 02 Nov 2015 10:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="near"',
  "",
  "--near",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "See the attachment.",
  "--near",
  'Content-Type: application/zip; name="archive.zip"',
  'Content-Disposition: attachment; filename="archive.zip"',
  "Content-Transfer-Encoding: base64",
  "",
  "",
].join("\r\n");
const nearLimitBytes = Math.floor(((25 * 1024 * 1024 - 2048) * 57) / 78);
write(
  "near-limit-25mib.mbox",
  `${framed("before near limit", "small")}${SEPARATOR}\r\n${nearLimitHead}${wrappedBase64(randomBytes(randomFrom(8), nearLimitBytes))}\r\n--near--\r\n\r\n${framed("after near limit", "small")}`,
  { stored: 3 },
);

const whole = framed("complete message", "all here");
const cut = framed("cut off message", "this body keeps going");
write("truncated.mbox", whole + cut.slice(0, cut.length - 12), {
  stored: 1,
  unreadable: { reason: "truncated", hint: "cut off message" },
});

writeFileSync(
  join(outDir, "expected.json"),
  `${JSON.stringify(expected, null, 2)}\n`,
);
for (const [name, facts] of Object.entries(expected)) {
  console.log(`${name.padEnd(24)} ${String(facts.size).padStart(10)} bytes`);
}
