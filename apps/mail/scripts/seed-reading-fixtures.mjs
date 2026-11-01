// Local only. Seeds a `wrangler dev` server with people, mailboxes, and mail, all
// delivered through the real inbound path. Run after `bun run db:migrate:local`.
//   bun apps/mail/scripts/seed-reading-fixtures.mjs <primary-domain> [bulk-count]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const [domain, bulkArgument = "0"] = process.argv.slice(2);
if (!domain) {
  console.error(
    "Usage: bun apps/mail/scripts/seed-reading-fixtures.mjs <primary-domain> [bulk-count]",
  );
  process.exit(1);
}
const BULK = Number(bulkArgument);
const SERVER = process.env.WRANGLER_DEV ?? "http://localhost:8787";
const FIXTURES = join(import.meta.dir, "../fixtures");
const PASSWORD = "local-password-123";

const MAILBOXES = {
  alex: "00000000-0000-4000-8000-00000000000a",
  sam: "00000000-0000-4000-8000-00000000000b",
  outsider: "00000000-0000-4000-8000-00000000000c",
  support: "00000000-0000-4000-8000-0000000000aa",
};

const address = (name) => `${name}@${domain}`;

for (const person of ["alex", "sam", "outsider"]) {
  await $`bun apps/auth/scripts/seed-user-local.mjs ${address(person)} ${PASSWORD} user`.quiet();
}

const userId = (person) =>
  `(SELECT id FROM user WHERE email = '${address(person)}')`;
const sql = [
  `INSERT OR REPLACE INTO domains (name, is_primary) VALUES ('${domain}', 1)`,
  ...Object.entries(MAILBOXES).flatMap(([name, id]) => [
    `INSERT OR REPLACE INTO mailboxes (id, kind, name) VALUES ('${id}', '${name === "support" ? "shared" : "personal"}', '${name === "support" ? "Support" : name}')`,
    `INSERT OR REPLACE INTO addresses (address, domain, mailbox_id, kind) VALUES ('${address(name)}', '${domain}', '${id}', 'primary')`,
  ]),
  ...["alex", "sam", "outsider"].map(
    (person) =>
      `INSERT OR REPLACE INTO mailbox_access (mailbox_id, user_id, role) VALUES ('${MAILBOXES[person]}', ${userId(person)}, 'manager')`,
  ),
  ...["alex", "sam"].map(
    (person) =>
      `INSERT OR REPLACE INTO mailbox_access (mailbox_id, user_id, role) VALUES ('${MAILBOXES.support}', ${userId(person)}, 'member')`,
  ),
].join("; ");
await $`bunx wrangler d1 execute DB --local --command ${sql}`.quiet();

async function deliver(from, to, lines) {
  const response = await fetch(
    `${SERVER}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    { method: "POST", body: lines.join("\r\n") },
  );
  if (!response.ok) {
    throw new Error(`Delivery to ${to} failed: ${response.status}`);
  }
}

let serial = 0;
function headers({ from, to, subject, id, references, minutesAgo = 0 }) {
  serial += 1;
  const date = new Date(Date.now() - minutesAgo * 60_000).toUTCString();
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${id ?? `fixture-${serial}-${Date.now()}`}@example.org>`,
    ...(references
      ? [
          `In-Reply-To: <${references.at(-1)}@example.org>`,
          `References: ${references.map((one) => `<${one}@example.org>`).join(" ")}`,
        ]
      : []),
    "MIME-Version: 1.0",
  ];
}

const plain = (body) => [
  "Content-Type: text/plain; charset=utf-8",
  "",
  ...body.split("\n"),
];
const html = (body) => [
  "Content-Type: text/html; charset=utf-8",
  "",
  ...body.split("\n"),
];

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC";

const person = "Priya Raman <priya@example.org>";
const to = address("alex");

await deliver("priya@example.org", to, [
  ...headers({
    from: person,
    to,
    subject: "Quarterly numbers",
    id: "thread-a1",
    minutesAgo: 3000,
  }),
  ...plain(
    "Hi Alex,\nThe numbers are at https://example.com/q3-report. Have a look before Friday.\n\nPriya",
  ),
]);
await deliver("jon@example.org", to, [
  ...headers({
    from: "Jon Bell <jon@example.org>",
    to,
    subject: "Re: Quarterly numbers",
    id: "thread-a2",
    references: ["thread-a1"],
    minutesAgo: 1500,
  }),
  ...plain("Looks right to me, apart from the travel line."),
]);
await deliver("priya@example.org", to, [
  ...headers({
    from: person,
    to,
    subject: "Re: Quarterly numbers",
    id: "thread-a3",
    references: ["thread-a1", "thread-a2"],
    minutesAgo: 30,
  }),
  ...html(
    '<div dir="ltr"><p>Thanks both. Travel is fixed now. Final copy is <a href="https://example.com/final">here</a>.</p><blockquote>Looks right to me, apart from the travel line.</blockquote></div>',
  ),
]);

await deliver("news@example.org", to, [
  ...headers({
    from: "Example News <news@example.org>",
    to,
    subject: "This week's product news",
    minutesAgo: 120,
  }),
  ...html(
    `<table bgcolor="white" width="600" style="background:white;color:black"><tr><td><h1 style="color:navy">This week</h1><img src="http://canary.localhost:9911/newsletter-tracker.png" width="600" height="200" alt="A big banner"><p>We shipped three things. Read about them <a href="https://example.com/news">on our site</a>.</p></td></tr></table>`,
  ),
]);

await deliver("pat@example.org", to, [
  ...headers({
    from: "Pat Lee <pat@example.org>",
    to,
    subject: "Contract and a logo",
    minutesAgo: 200,
  }),
  'Content-Type: multipart/mixed; boundary="outer"',
  "",
  "--outer",
  'Content-Type: multipart/related; boundary="inner"',
  "",
  "--inner",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Contract attached. Here is our logo: <img src="cid:logo@x" alt="Logo" width="40"></p>',
  "--inner",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <logo@x>",
  'Content-Disposition: inline; filename="logo.png"',
  "",
  PNG,
  "--inner--",
  "--outer",
  "Content-Type: application/pdf",
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="contract final.pdf"',
  "",
  "JVBERi0xLjQK",
  "--outer",
  "Content-Type: text/html",
  "Content-Transfer-Encoding: base64",
  `Content-Disposition: attachment; filename="invoice‮fdp.html"`,
  "",
  btoa("<script>document.title='attachment ran'</script>"),
  "--outer--",
]);

await deliver("evil@example.net", to, [
  ...headers({
    from: `"</script><script>document.title='PWNED by sender'</script>" <evil@example.net>`,
    to,
    subject: `<img src=x onerror=alert(1)> Hostile everything`,
    minutesAgo: 5,
  }),
  ...html(readFileSync(join(FIXTURES, "hostile-everything.txt"), "utf8")),
]);
await deliver("evil@example.net", to, [
  ...headers({
    from: "Tall Page <tall@example.net>",
    to,
    subject: "A very tall page",
    minutesAgo: 6,
  }),
  ...html(readFileSync(join(FIXTURES, "hostile-tall.txt"), "utf8")),
]);

await deliver("evil@example.net", to, [
  ...headers({
    from: "Link Tricks <links@example.net>",
    to,
    subject: "Hostile links and form",
    minutesAgo: 7,
  }),
  ...html(readFileSync(join(FIXTURES, "hostile-links.txt"), "utf8")),
]);

await deliver("evil@example.net", to, [
  ...headers({
    from: "Hidden Loads <loads@example.net>",
    to,
    subject: "Hostile loads",
    minutesAgo: 8,
  }),
  ...html(
    readFileSync(join(FIXTURES, "hostile-loads.txt"), "utf8")
      .replaceAll("__DOMAIN_UPPER__", domain.toUpperCase())
      .replaceAll("__DOMAIN__", domain),
  ),
]);

// Each stands alone, so the "Show images" button can only be there because of it.
for (const [subject, body] of [
  [
    "Remote CSS import",
    `<style>@import "http://canary.localhost:9911/only-import.css";</style><p>Import only.</p>`,
  ],
  [
    "Remote CSS image set",
    `<style>p { background-image: image-set("http://canary.localhost:9911/only-image-set.png" 1x); }</style><p>Image set only.</p>`,
  ],
  [
    "Remote CSS escape",
    `<style>p { background: \\75 rl(http://canary.localhost:9911/only-escaped.png); }</style><p>Escaped only.</p>`,
  ],
  [
    "Unfinished image tag",
    `<p>Before the tag.</p><img src=http://canary.localhost:9911/unfinished-img.png onerror="fetch('http://canary.localhost:9911/unfinished-onerror')"`,
  ],
  [
    "Unfinished meta tag",
    `<p>Before the tag.</p><meta http-equiv=refresh content="0;url=http://canary.localhost:9911/unfinished-meta"`,
  ],
  [
    "Unfinished frame tag",
    `<p>Before the tag.</p><iframe src="http://canary.localhost:9911/unfinished-iframe`,
  ],
]) {
  await deliver("evil@example.net", to, [
    ...headers({
      from: "Hidden Loads <loads@example.net>",
      to,
      subject,
      minutesAgo: 9,
    }),
    ...html(body),
  ]);
}

await deliver("evil@example.net", to, [
  ...headers({
    from: "Lying Picture <liar@example.net>",
    to,
    subject: "A picture that is not one",
    minutesAgo: 10,
  }),
  'Content-Type: multipart/related; boundary="b"',
  "",
  "--b",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>This inline file says it is a PNG.</p><img src="cid:liar@x" alt="Not a picture">',
  "--b",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <liar@x>",
  'Content-Disposition: inline; filename="liar.png"',
  "",
  btoa("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"),
  "--b--",
]);

const toSupport = address("support");
for (const [index, subject] of [
  "I can't sign in",
  "Refund for order 4471",
  "Thanks for the quick reply",
].entries()) {
  await deliver("customer@example.org", toSupport, [
    ...headers({
      from: `Customer ${index + 1} <customer${index + 1}@example.org>`,
      to: toSupport,
      subject,
      minutesAgo: 60 * (index + 1),
    }),
    ...plain(`Hello, this is about: ${subject}.`),
  ]);
}

await deliver("private@example.org", address("outsider"), [
  ...headers({
    from: "Private Sender <private@example.org>",
    to: address("outsider"),
    subject: "For the outsider only",
  }),
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "Private.",
  "--b",
  "Content-Type: application/pdf",
  'Content-Disposition: attachment; filename="private.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--b--",
]);

const BATCH = 25;
for (let start = 0; start < BULK; start += BATCH) {
  await Promise.all(
    Array.from({ length: Math.min(BATCH, BULK - start) }, (_, offset) => {
      const index = start + offset;
      return deliver("bulk@example.org", address("sam"), [
        ...headers({
          from: `Sender ${index % 40} <sender${index % 40}@example.org>`,
          to: address("sam"),
          subject: `Bulk message number ${index}`,
          minutesAgo: index * 7,
        }),
        ...plain(`This is the body of bulk message ${index}.`),
      ]);
    }),
  );
}

console.log(
  JSON.stringify(
    { password: PASSWORD, mailboxes: MAILBOXES, bulk: BULK },
    null,
    2,
  ),
);
