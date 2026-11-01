// Realistic raw messages and the folder each one should land in. These pin the shapes
// that matter most: real mail that must not reach Spam, and forgeries that must. Run on
// Bun by apps/mail/src/spam/fixtures.test.ts. Each one's message id is unique to the run,
// so they can also be posted to `wrangler dev`.
//
// `real` says what the message is, and `folder` says where it goes, so a row where they
// disagree is a cost or a miss we accept, and its `limit` says why.

export type SpamFixture = {
  id: string;
  real: boolean;
  folder: "inbox" | "spam";
  limit?: string;
  before?: {
    allow?: string;
    block?: string;
    // This mailbox has sent a message with this Message-ID.
    sentId?: string;
    // This mailbox already has ordinary mail from this address.
    knownSender?: string;
    // A copy that lands in Spam first and someone marks "Not spam".
    notSpam?: Shape;
  };
  shape: Shape;
};

type Shape = {
  from: string;
  subject: string;
  // Everything after `mx.cloudflare.net;`. Absent means no such header at all.
  auth?: string;
  headers?: string[];
  text?: string;
  html?: string;
  attachment?: { filename: string; type: string };
  calendar?: boolean;
};

const addressOf = (from: string) => /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from;

export function renderFixture(
  shape: Shape,
  { id, to, stamp }: { id: string; to: string; stamp: string },
): string {
  const sender = addressOf(shape.from);
  const domain = sender.slice(sender.lastIndexOf("@") + 1);
  const head = [
    ...(shape.auth
      ? [`Authentication-Results: mx.cloudflare.net; ${shape.auth}`]
      : []),
    `Received: from mail-out.${domain} (mail-out.${domain} [192.0.2.25]) by mx.cloudflare.net with ESMTPS; Mon, 02 Nov 2026 10:00:02 +0000`,
    `From: ${shape.from}`,
    `To: ${to}`,
    `Subject: ${shape.subject}`,
    "Date: Mon, 02 Nov 2026 10:00:00 +0000",
    `Message-ID: <${id}-${stamp}@${domain}>`,
    ...(shape.headers ?? []),
    "MIME-Version: 1.0",
  ];
  const body = shape.html
    ? ["Content-Type: text/html; charset=utf-8", "", shape.html]
    : ["Content-Type: text/plain; charset=utf-8", "", shape.text ?? "Hello."];
  if (shape.calendar) {
    return [
      ...head,
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      ...body,
      "--alt",
      "Content-Type: text/calendar; charset=utf-8; method=REQUEST",
      "",
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "SUMMARY:Quarterly planning",
      "DTSTART:20261110T010000Z",
      "END:VEVENT",
      "END:VCALENDAR",
      "--alt--",
    ].join("\r\n");
  }
  if (!shape.attachment) return [...head, ...body].join("\r\n");
  const { filename, type } = shape.attachment;
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="part"',
    "",
    "--part",
    ...body,
    "--part",
    `Content-Type: ${type}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQKJcTl8uXrp/Og0MTGCg==",
    "--part--",
  ].join("\r\n");
}

const spf = (result: string, domain: string) =>
  `spf=${result} smtp.mailfrom=bounces@${domain}`;
const aligned = (domain: string) =>
  `${spf("pass", domain)}; dkim=pass header.d=${domain} header.s=s1; dmarc=pass header.from=${domain}`;
const PDF = { filename: "invoice-2041.pdf", type: "application/pdf" };
const SCRIPT = { filename: "tidy-report.js", type: "text/javascript" };
const PROGRAM = {
  filename: "invoice-2041.pdf.exe",
  type: "application/octet-stream",
};
const TRACKED = (shown: string) =>
  `<html><body><h1>Five ideas for your garden</h1><p>Read them at <a href="https://click.mailservice.example/t/8841">www.${shown}</a>.</p><p><a href="https://click.mailservice.example/u">Unsubscribe</a></p></body></html>`;
const LIST_HEADERS = (list: string, domain: string) => [
  `List-Id: The ${list} list <${list}.${domain}>`,
  `List-Unsubscribe: <mailto:${list}-leave@${domain}>`,
  `List-Post: <mailto:${list}@${domain}>`,
  `Sender: ${list}-bounces@${domain}`,
  "Precedence: list",
];
const LIST_FOOTER =
  "\n\n--\ndevs mailing list\nhttps://lists.opensource.example/devs";
const OVERSEAS_REPLY_TO = "Reply-To: Accounts <accounts@billing-desk.example>";

export const SPAM_FIXTURES: SpamFixture[] = [
  {
    id: "list-post-p-none",
    real: true,
    folder: "inbox",
    shape: {
      from: "Ana Ortiz <ana@corner-bakery.example>",
      subject: "[devs] A patch for the parser crash on empty input",
      auth: `${spf("softfail", "lists.opensource.example")}; dkim=fail header.d=corner-bakery.example; dmarc=fail (p=NONE dis=none) header.from=corner-bakery.example`,
      headers: [
        ...LIST_HEADERS("devs", "lists.opensource.example"),
        "Reply-To: devs@lists.opensource.example",
      ],
      text: `Here's a patch for the crash. It adds a check before the first read.${LIST_FOOTER}`,
    },
  },
  {
    id: "list-post-no-stated-policy",
    real: true,
    folder: "inbox",
    shape: {
      from: "Ben Park <ben@hillside-school.example>",
      subject: "[devs] The meeting notes from the working group",
      auth: `${spf("softfail", "lists.opensource.example")}; dkim=fail; dmarc=fail header.from=hillside-school.example`,
      headers: [
        ...LIST_HEADERS("devs", "lists.opensource.example"),
        "Reply-To: devs@lists.opensource.example",
      ],
      text: `Notes are below, tell me if I missed anything.${LIST_FOOTER}`,
    },
  },
  {
    id: "list-post-rewrites-from",
    real: true,
    folder: "inbox",
    shape: {
      from: '"Chen Wood via devs" <devs@lists.opensource.example>',
      subject: "[devs] Whether to drop the old release next year",
      auth: aligned("lists.opensource.example"),
      headers: [
        ...LIST_HEADERS("devs", "lists.opensource.example"),
        "Reply-To: Chen Wood <chen@harbour-works.example>",
      ],
      text: `I think we can, once the next one is out.${LIST_FOOTER}`,
    },
  },
  {
    id: "forward-keeps-signature",
    real: true,
    folder: "inbox",
    shape: {
      from: "Dara Reid <dara@meridian-law.example>",
      subject: "Fwd: The contract, page four",
      auth: `${spf("fail", "forwarder.example")}; dkim=pass header.d=meridian-law.example; dmarc=pass header.from=meridian-law.example`,
      text: "See the payment terms on page four. Could you look before Thursday?",
    },
  },
  {
    id: "forward-changes-message-p-none",
    real: true,
    folder: "inbox",
    shape: {
      from: "Eli Fox <eli@kestrel-print.example>",
      subject: "Fwd: The roof repair quote",
      auth: `${spf("fail", "forwarder.example")}; dkim=fail header.d=kestrel-print.example; dmarc=fail (p=none dis=none) header.from=kestrel-print.example`,
      text: "Here's the quote. Forwarded through our old address, which adds a footer.",
    },
  },
  {
    id: "vendor-invoice-p-none",
    real: true,
    folder: "inbox",
    shape: {
      from: "Accounts <accounts@copperleaf-supply.example>",
      subject: "Invoice 2041 for October",
      auth: `${spf("pass", "copperleaf-supply.example")}; dkim=none; dmarc=fail (p=none) header.from=copperleaf-supply.example`,
      headers: [OVERSEAS_REPLY_TO],
      text: "Thanks for your order. Your invoice is attached, payable in 30 days.",
      attachment: PDF,
    },
  },
  {
    id: "vendor-on-mail-service-p-none",
    real: true,
    folder: "inbox",
    shape: {
      from: "Redfern Garden <news@redfern-garden.example>",
      subject: "Five ideas for your garden",
      auth: `${spf("pass", "mailservice.example")}; dkim=pass header.d=mailservice.example; dmarc=fail (p=none dis=none) header.from=redfern-garden.example`,
      headers: ["Reply-To: Help <help@helpdesk.mailservice.example>"],
      html: TRACKED("redfern-garden.example"),
    },
  },
  {
    id: "no-dmarc-record",
    real: true,
    folder: "inbox",
    shape: {
      from: "Gus Hill <gus@tallgrass-farm.example>",
      subject: "Do you have availability next month?",
      auth: `${spf("pass", "tallgrass-farm.example")}; dkim=none; dmarc=none header.from=tallgrass-farm.example`,
      text: "A friend gave me your details. Could someone call me this week?",
    },
  },
  {
    id: "newsletter",
    real: true,
    folder: "inbox",
    shape: {
      from: "Oakline News <news@oakline-tools.example>",
      subject: "What our readers are making this month",
      auth: aligned("oakline-tools.example"),
      headers: [
        "List-Unsubscribe: <https://click.mailservice.example/u>",
        "Reply-To: Help <help@helpdesk.mailservice.example>",
      ],
      html: TRACKED("oakline-tools.example"),
    },
  },
  {
    id: "newsletter-shortest-header",
    real: true,
    folder: "inbox",
    shape: {
      from: "Lakeside News <news@lakeside-events.example>",
      subject: "Local events you won't want to miss",
      auth: "spf=pass; dkim=pass; dmarc=pass",
      headers: ["Reply-To: Help <help@helpdesk.mailservice.example>"],
      html: TRACKED("lakeside-events.example"),
    },
  },
  {
    id: "calendar-invite",
    real: true,
    folder: "inbox",
    shape: {
      from: '"hana.ito@brightpath.example (Calendar)" <calendar-notification@calendar.example>',
      subject: "Invitation: Quarterly planning on 10 November",
      auth: aligned("calendar.example"),
      headers: ["Reply-To: Hana Ito <hana.ito@brightpath.example>"],
      text: "Hana Ito has invited you to Quarterly planning.",
      calendar: true,
    },
  },
  {
    id: "document-invite-from-a-service",
    real: true,
    folder: "inbox",
    shape: {
      from: '"ivan.lee@alderway.example via Docs" <comments-noreply@docs.example>',
      subject: "A document was shared with you",
      auth: aligned("docs.example"),
      headers: ["Reply-To: Ivan Lee <ivan.lee@alderway.example>"],
      text: "Ivan Lee shared Budget 2027 with you. Open it from your documents.",
    },
  },
  {
    id: "receipt-in-capitals",
    real: true,
    folder: "inbox",
    shape: {
      from: "Sunbeam Billing <billing@sunbeam-power.example>",
      subject: "PAYMENT RECEIVED THANK YOU",
      auth: aligned("sunbeam-power.example"),
      headers: [OVERSEAS_REPLY_TO],
      text: "Thanks for your payment of $84.20. Your receipt is attached.",
      attachment: { ...PDF, filename: "receipt-5518.pdf" },
    },
  },
  {
    id: "colleague-sending-a-script",
    real: true,
    folder: "inbox",
    before: { knownSender: "kai@northwind-team.example" },
    shape: {
      from: "Kai Lee <kai@northwind-team.example>",
      subject: "The script I mentioned",
      auth: aligned("northwind-team.example"),
      text: "Here's the small script that tidies the report.",
      attachment: SCRIPT,
    },
  },
  {
    id: "first-plain-note",
    real: true,
    folder: "inbox",
    shape: {
      from: "Lena Moore <lena.moore84@mail.example>",
      subject: "quick question",
      auth: aligned("mail.example"),
      text: "Hi, are you still doing the Saturday classes? Thanks, Lena",
    },
  },
  {
    id: "first-note-small-domain-softfail",
    real: true,
    folder: "inbox",
    shape: {
      from: "Mo Tran <mo@lanternwork.example>",
      subject: "URGENT QUOTE NEEDED TODAY",
      auth: `${spf("softfail", "lanternwork.example")}; dkim=none; dmarc=none`,
      text: "Hello, I need a quote for two rooms by this afternoon if possible.",
    },
  },
  {
    id: "no-authentication-results",
    real: true,
    folder: "inbox",
    shape: {
      from: "Nia Shah <nia@pebble-design.example>",
      subject: "Your website copy",
      text: "I had a look at the pricing section. It reads well.",
    },
  },
  {
    id: "first-header-from-another-server",
    real: true,
    folder: "inbox",
    shape: {
      from: "Omar Khan <omar@juniper-cycles.example>",
      subject: "Your bike is ready",
      headers: [
        "Authentication-Results: mx.other-host.example; spf=fail; dkim=fail; dmarc=fail (p=reject)",
      ],
      text: "Pick it up any day this week.",
    },
  },
  {
    id: "non-english-japanese",
    real: true,
    folder: "inbox",
    shape: {
      from: "=?UTF-8?B?5bGx55Sw5aSq6YOO?= <yamada@sakura-shoji.example>",
      subject: "=?UTF-8?B?6KaL56mN5pu444Gu44GU5L6d6aC8?=",
      auth: `${spf("softfail", "sakura-shoji.example")}; dkim=none; dmarc=fail (p=none) header.from=sakura-shoji.example`,
      text: "お世話になっております。見積書をお送りいただけますでしょうか。",
    },
  },
  {
    id: "non-english-greek-capitals",
    real: true,
    folder: "inbox",
    shape: {
      from: "Νίκος Παππάς <nikos@aigaio-ploia.example>",
      subject: "ΕΠΕΙΓΟΝ ΤΙΜΟΛΟΓΙΟ ΓΙΑ ΤΟΝ ΟΚΤΩΒΡΙΟ",
      auth: `${spf("pass", "aigaio-ploia.example")}; dkim=none; dmarc=none`,
      text: "Σας στέλνω το τιμολόγιο για τον Οκτώβριο. Ευχαριστώ.",
    },
  },
  {
    id: "reply-to-our-mail-p-none",
    real: true,
    folder: "inbox",
    before: { sentId: "ours-1@cloudysuite.example" },
    shape: {
      from: "Pia Ng <pia@willow-consult.example>",
      subject: "Re: Moving the client workshop",
      auth: `${spf("softfail", "willow-consult.example")}; dkim=fail header.d=willow-consult.example; dmarc=fail (p=NONE dis=none) header.from=willow-consult.example`,
      headers: [
        "In-Reply-To: <ours-1@cloudysuite.example>",
        "References: <ours-1@cloudysuite.example>",
      ],
      text: "The second week works for us.",
    },
  },
  {
    id: "reply-to-our-mail-looks-odd",
    real: true,
    folder: "inbox",
    before: { sentId: "ours-2@cloudysuite.example" },
    shape: {
      from: '"desk@quartz-hire.example" <quinn@tundra-trade.example>',
      subject: "RE: THE DELIVERY DELAY",
      auth: `${spf("softfail", "tundra-trade.example")}; dkim=fail; dmarc=fail (p=none) header.from=tundra-trade.example`,
      headers: [
        "In-Reply-To: <ours-2@cloudysuite.example>",
        "Reply-To: Desk <desk@quartz-hire.example>",
      ],
      text: "Passing this on to the desk, who can answer.",
    },
  },
  {
    id: "allowed-address-with-broken-checks",
    real: true,
    folder: "inbox",
    before: { allow: "mina@corner-cafe.example" },
    shape: {
      from: "Mina Costa <mina@corner-cafe.example>",
      subject: "SPECIALS THIS WEEK AT THE CAFE",
      auth: `${spf("softfail", "corner-cafe.example")}; dkim=fail header.d=corner-cafe.example; dmarc=fail (p=none dis=none) header.from=corner-cafe.example`,
      headers: ["Reply-To: Bookings <bookings@table-desk.example>"],
      text: "Soup on Tuesday, and the lemon cake is back.",
    },
  },
  {
    id: "allowed-domain-with-broken-checks",
    real: true,
    folder: "inbox",
    before: { allow: "saffron-kitchen.example" },
    shape: {
      from: "Rosa Evans <rosa@saffron-kitchen.example>",
      subject: "Your catering order",
      auth: `${spf("fail", "saffron-kitchen.example")}; dkim=fail; dmarc=fail header.from=saffron-kitchen.example`,
      text: "All booked for the 14th.",
    },
  },
  {
    id: "allowed-loud-sender-shortest-header",
    real: true,
    folder: "inbox",
    before: { allow: "sam@loud-traders.example" },
    shape: {
      from: '"deals@bigstore.example" <sam@loud-traders.example>',
      subject: "HUGE SAVINGS ENDING TONIGHT ONLY",
      auth: "spf=pass; dkim=pass; dmarc=pass",
      headers: ["Reply-To: Orders <orders@other-desk.example>"],
      html: TRACKED("bigstore.example"),
    },
  },
  {
    id: "allowed-list-by-its-signature",
    real: true,
    folder: "inbox",
    before: { allow: "lists.signed-group.example" },
    shape: {
      from: "Tess Wood <tess@strict-bank.example>",
      subject: "[gardeners] Frost dates this year",
      auth: `${spf("pass", "lists.signed-group.example")}; dkim=pass header.d=lists.signed-group.example; dmarc=fail (p=reject dis=none) header.from=strict-bank.example`,
      headers: LIST_HEADERS("gardeners", "lists.signed-group.example"),
      text: "When do people plant out where you are?",
    },
  },
  {
    id: "allowed-list-by-its-list-id",
    real: true,
    folder: "inbox",
    before: { allow: "lists.plain-group.example" },
    shape: {
      from: "Uma Fox <uma@thimble-arts.example>",
      subject: "[choir] Rehearsal moved",
      auth: `${spf("softfail", "lists.plain-group.example")}; dkim=fail; dmarc=fail (p=none) header.from=thimble-arts.example`,
      headers: LIST_HEADERS("choir", "lists.plain-group.example"),
      text: "Rehearsal is at 7 this week.",
    },
  },
  {
    id: "marked-not-spam-then-next-message",
    real: true,
    folder: "inbox",
    before: {
      notSpam: {
        from: '"bookings@table-desk.example" <vik@corner-diner.example>',
        subject: "SPECIALS AT THE DINER THIS WEEK",
        auth: `${spf("softfail", "corner-diner.example")}; dkim=fail; dmarc=fail (p=none) header.from=corner-diner.example`,
        headers: ["Reply-To: Bookings <bookings@table-desk.example>"],
        text: "Pancakes all week.",
      },
    },
    shape: {
      from: '"bookings@table-desk.example" <vik@corner-diner.example>',
      subject: "SPECIALS AT THE DINER NEXT WEEK",
      auth: `${spf("softfail", "corner-diner.example")}; dkim=fail; dmarc=fail (p=none) header.from=corner-diner.example`,
      headers: ["Reply-To: Bookings <bookings@table-desk.example>"],
      text: "Waffles next week.",
    },
  },

  {
    id: "marked-not-spam-newsletter-with-broken-checks",
    real: true,
    folder: "inbox",
    before: {
      notSpam: {
        from: "Velvet Books <news@velvet-books.example>",
        subject: "New in this month",
        auth: `${spf("softfail", "velvet-books.example")}; dkim=fail; dmarc=fail (p=none) header.from=velvet-books.example`,
        headers: ["Reply-To: Help <help@helpdesk.mailservice.example>"],
        html: TRACKED("velvet-books.example"),
      },
    },
    shape: {
      from: "Velvet Books <news@velvet-books.example>",
      subject: "New in next month",
      auth: `${spf("softfail", "velvet-books.example")}; dkim=fail; dmarc=fail (p=none) header.from=velvet-books.example`,
      headers: ["Reply-To: Help <help@helpdesk.mailservice.example>"],
      html: TRACKED("velvet-books.example"),
    },
  },

  // Real mail that goes to Spam, by decision.
  {
    id: "list-post-from-a-strict-domain",
    real: true,
    folder: "spam",
    limit:
      "A domain with an enforcing policy says failing mail isn't theirs, and nothing here can tell a list from a forger. Allowing a list that signs its posts brings this back.",
    shape: {
      from: "Wren Adams <wren@strict-insurer.example>",
      subject: "[devs] A question about the build on arm machines",
      auth: `${spf("softfail", "lists.opensource.example")}; dkim=fail header.d=strict-insurer.example; dmarc=fail (p=quarantine dis=none) header.from=strict-insurer.example`,
      headers: LIST_HEADERS("devs", "lists.opensource.example"),
      text: `Does anyone else see this?${LIST_FOOTER}`,
    },
  },
  {
    id: "stranger-sending-a-script",
    real: true,
    folder: "spam",
    limit: "A program from someone this mailbox has never dealt with.",
    shape: {
      from: "Yara Jones <yara@marigold-labs.example>",
      subject: "The script I mentioned",
      auth: aligned("marigold-labs.example"),
      text: "Here's the small script that tidies the report.",
      attachment: SCRIPT,
    },
  },

  // Forgeries that go to Spam.
  {
    id: "forged-bank-p-reject",
    real: false,
    folder: "spam",
    shape: {
      from: "Security Team <security@bigbank.example>",
      subject: "Action required on your account",
      auth: `${spf("fail", "bigbank.example")}; dkim=none; dmarc=fail (p=REJECT dis=NONE) header.from=bigbank.example`,
      text: "Please confirm your details today.",
    },
  },
  {
    id: "forged-bank-p-quarantine",
    real: false,
    folder: "spam",
    shape: {
      from: "Security Team <security@mid-bank.example>",
      subject: "Action required on your account",
      auth: `${spf("pass", "attacker-host.example")}; dkim=none; dmarc=fail (p=quarantine) header.from=mid-bank.example`,
      text: "Please confirm your details today.",
    },
  },
  {
    id: "unaligned-signature-does-not-cancel-spf",
    real: false,
    folder: "spam",
    shape: {
      from: '"support@paypal.example" <ceo@nodmarc.example>',
      subject: "A payment for today",
      auth: `${spf("fail", "nodmarc.example")}; dkim=pass header.d=evil.example; dmarc=none`,
      headers: ["Reply-To: CEO <ceo.private@freemail.example>"],
      text: "Can you handle a payment for me today? I'm in meetings.",
    },
  },
  {
    id: "unsigned-twin-of-that",
    real: false,
    folder: "spam",
    shape: {
      from: '"support@paypal.example" <ceo2@nodmarc.example>',
      subject: "A payment for today",
      auth: `${spf("fail", "nodmarc.example")}; dkim=none; dmarc=none`,
      headers: ["Reply-To: CEO <ceo.private@freemail.example>"],
      text: "Can you handle a payment for me today? I'm in meetings.",
    },
  },
  {
    id: "lookalike-phish-normal-anchor",
    real: false,
    folder: "spam",
    shape: {
      from: '"support@oakline-tools.example" <alert@oakline-secure.example>',
      subject: "Your account has been limited",
      auth: aligned("oakline-secure.example"),
      headers: ["Reply-To: Help <help@freemail.example>"],
      html: '<p>Verify now.</p><a href="http://steal.example/login">https://www.oakline-tools.example/verify</a>',
    },
  },
  {
    id: "lookalike-phish-after-unclosed-anchor",
    real: false,
    folder: "spam",
    shape: {
      from: '"support@oakline-tools.example" <alert@oakline-verify.example>',
      subject: "Your account has been limited",
      auth: aligned("oakline-verify.example"),
      html: '<a href="http://preload.example"\n<p>Verify now.</p>\n<a href="http://steal.example/login">https://www.oakline-tools.example/verify</a>',
    },
  },
  {
    id: "forged-p-none-brand-with-misleading-link",
    real: false,
    folder: "spam",
    shape: {
      from: "Billing <billing@kestrel-print.example>",
      subject: "Your invoice is overdue",
      auth: `${spf("softfail", "kestrel-print.example")}; dkim=none; dmarc=fail (p=none) header.from=kestrel-print.example`,
      html: '<p>Pay now.</p><a href="http://steal.example/pay">www.kestrel-print.example</a>',
    },
  },
  {
    id: "stranger-with-a-program",
    real: false,
    folder: "spam",
    shape: {
      from: "Accounts <accounts@harbourview-co.example>",
      subject: "Overdue invoice attached",
      auth: `${spf("pass", "harbourview-co.example")}; dkim=none; dmarc=none`,
      text: "Please open the attached file to see your overdue invoice.",
      attachment: PROGRAM,
    },
  },
  {
    id: "blocked-sender-with-passing-checks",
    real: false,
    folder: "spam",
    before: { block: "pest@noisy-sales.example" },
    shape: {
      from: "Pest <pest@noisy-sales.example>",
      subject: "One more offer",
      auth: aligned("noisy-sales.example"),
      text: "Just one more.",
    },
  },
  {
    id: "blocked-sender-inside-an-allowed-list",
    real: false,
    folder: "spam",
    before: {
      block: "pest@loud-member.example",
      allow: "lists.noisy-group.example",
    },
    shape: {
      from: "Pest <pest@loud-member.example>",
      subject: "[group] One more offer",
      auth: `${spf("pass", "lists.noisy-group.example")}; dkim=pass header.d=lists.noisy-group.example; dmarc=none`,
      headers: LIST_HEADERS("group", "lists.noisy-group.example"),
      text: "Just one more.",
    },
  },
  {
    id: "forged-allowed-sender-p-quarantine",
    real: false,
    folder: "spam",
    before: { allow: "boss@strict-corp.example" },
    shape: {
      from: "The Boss <boss@strict-corp.example>",
      subject: "A payment for today",
      auth: `${spf("fail", "strict-corp.example")}; dkim=none; dmarc=fail (p=quarantine) header.from=strict-corp.example`,
      text: "Can you handle a payment for me today?",
    },
  },
  {
    id: "forged-allowed-sender-misleading-link",
    real: false,
    folder: "spam",
    before: { allow: "boss@loose-corp.example" },
    shape: {
      from: "The Boss <boss@loose-corp.example>",
      subject: "Please look at this",
      auth: `${spf("softfail", "loose-corp.example")}; dkim=none; dmarc=none`,
      html: '<p>Please look.</p><a href="http://steal.example/x">www.loose-corp.example</a>',
    },
  },
  {
    id: "forged-allowed-sender-lookalike-name",
    real: false,
    folder: "spam",
    before: { allow: "boss@loose-firm.example" },
    shape: {
      from: '"support@paypal.example" <boss@loose-firm.example>',
      subject: "Please look at this",
      auth: `${spf("fail", "loose-firm.example")}; dkim=none; dmarc=fail (p=none) header.from=loose-firm.example`,
      text: "Please look at this today.",
    },
  },
  {
    id: "forged-allowed-sender-two-from-addresses",
    real: false,
    folder: "spam",
    before: { allow: "boss@any-firm.example" },
    shape: {
      from: "The Boss <boss@any-firm.example>, Me <me@attacker-host.example>",
      subject: "Please look at this",
      auth: "spf=pass; dkim=pass; dmarc=pass",
      text: "Please look at this today.",
    },
  },
  {
    id: "forged-not-spam-sender-p-reject",
    real: false,
    folder: "spam",
    before: {
      notSpam: {
        from: "Vera Lang <vera@strict-supplies.example>",
        subject: "Your October order",
        auth: `${spf("softfail", "strict-supplies.example")}; dkim=fail; dmarc=fail (p=reject) header.from=strict-supplies.example`,
        text: "Your order shipped.",
      },
    },
    shape: {
      from: "Vera Lang <vera@strict-supplies.example>",
      subject: "New bank details",
      auth: `${spf("fail", "strict-supplies.example")}; dkim=none; dmarc=fail (p=reject) header.from=strict-supplies.example`,
      text: "We have changed banks. Please update your records.",
    },
  },

  {
    id: "forged-not-spam-sender-new-misleading-link",
    real: false,
    folder: "spam",
    before: {
      notSpam: {
        from: "Willow Books <news@willow-books.example>",
        subject: "New in this month",
        auth: `${spf("softfail", "willow-books.example")}; dkim=fail; dmarc=fail (p=none) header.from=willow-books.example`,
        headers: ["Reply-To: Help <help@helpdesk.mailservice.example>"],
        html: TRACKED("willow-books.example"),
      },
    },
    shape: {
      from: "Willow Books <news@willow-books.example>",
      subject: "Your order needs attention",
      auth: `${spf("softfail", "willow-books.example")}; dkim=fail; dmarc=fail (p=none) header.from=willow-books.example`,
      html: '<p>Please look.</p><a href="http://steal.example/x">www.willow-books.example</a>',
    },
  },

  // Forgeries that reach the Inbox, because real mail in Spam is the worse mistake.
  {
    id: "plain-forgery-of-a-p-none-domain",
    real: false,
    folder: "inbox",
    limit:
      "A domain with p=none asks for nothing, and this has no other tell. It looks just like a vendor with a half-set record.",
    shape: {
      from: "Accounts <accounts@copperleaf-trade.example>",
      subject: "New bank details for your next payment",
      auth: `${spf("fail", "copperleaf-trade.example")}; dkim=none; dmarc=fail (p=none) header.from=copperleaf-trade.example`,
      headers: ["Reply-To: Accounts <accounts.desk@freemail.example>"],
      text: "We have changed banks. Please reply to confirm.",
    },
  },
  {
    id: "plain-forgery-of-an-allowed-p-none-sender",
    real: false,
    folder: "inbox",
    limit:
      "The case that can't be told apart: a person said they trust this sender, the domain enforces nothing, and the message has no other sign. Rescue wins.",
    before: { allow: "friend@loose-cafe.example" },
    shape: {
      from: "A Friend <friend@loose-cafe.example>",
      subject: "Can you help today?",
      auth: `${spf("fail", "loose-cafe.example")}; dkim=none; dmarc=fail (p=none) header.from=loose-cafe.example`,
      text: "Can you buy some gift cards for me today?",
    },
  },
  {
    id: "allowed-sender-link-with-no-failed-check",
    real: false,
    folder: "inbox",
    limit:
      "No check failed and the domain has no DMARC record. Tracked newsletters look the same, so the link scores 4 points and doesn't file it alone.",
    before: { allow: "friend@nodmarc-cafe.example" },
    shape: {
      from: "A Friend <friend@nodmarc-cafe.example>",
      subject: "Please look at this",
      auth: `${spf("pass", "attacker-host.example")}; dkim=none; dmarc=none`,
      html: '<p>Please look.</p><a href="http://steal.example/x">www.nodmarc-cafe.example</a>',
    },
  },
];
