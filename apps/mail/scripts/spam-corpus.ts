// A labelled corpus of made-up mail, so the spam filter's numbers can be repeated.
// Everything here is synthetic, including how often each kind of mail turns up, so
// its rates say how the filter treats these shapes of mail and not how accurate it
// would be on anyone's real mail. bun test apps/mail/src/spam/corpus.test.ts reads it.

export type CorpusLabel = "ham" | "spam";

export type CorpusMessage = {
  label: CorpusLabel;
  kind: string;
  campaign: string | null;
  raw: string;
};

type Auth = { spf: string; dkim: string; dmarc: string; policy?: string };

// A small deterministic generator, so a seed always gives the same corpus.
function randomFrom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: <Item>(items: readonly Item[]): Item =>
      items[Math.floor(next() * items.length)]!,
    between: (low: number, high: number) =>
      low + Math.floor(next() * (high - low + 1)),
  };
}
type Random = ReturnType<typeof randomFrom>;

const FIRST =
  "Ana Ben Chen Dara Eli Farah Gus Hana Ivan Jo Kai Lena Mo Nia Omar Pia Quinn Rosa Sam Tess Uma Vik Wren Yara Zoe".split(
    " ",
  );
const LAST =
  "Adams Brown Chen Davis Evans Fox Garcia Hill Ito Jones Khan Lee Moore Ng Ortiz Park Reid Shah Tran Wood".split(
    " ",
  );
const COMPANIES =
  "northwind brightpath oakline harbourview tallgrass redfern lakeside kestrel meridian copperleaf sunbeam alderway".split(
    " ",
  );
const TLDS = ["com", "org", "net", "co.uk", "com.au", "io"];
const THROWAWAY =
  "x7-deals promo-zone best-offer4u winbig247 cheapmeds-now fast-loans-today lucky-spin crypto-yield-pro".split(
    " ",
  );
const FREEMAIL = ["gmail.com", "outlook.com", "yahoo.com", "proton.me"];

const WORK_TOPICS = [
  "the quarterly budget review and which line items need another look",
  "moving the client workshop to the second week of the month",
  "the draft contract, especially the payment terms on page four",
  "hiring plans for the warehouse team over the coming season",
  "the roof repair quote and whether the insurer will cover it",
  "next week's board pack and who is writing the operations section",
  "the delivery delay from our supplier and what we tell customers",
  "the new roster for the front desk and the weekend cover",
  "feedback on the website copy, mostly the pricing section",
  "the audit findings and the small changes to our expense process",
];
const WORK_LINES = [
  "Could you take a look before our call on Thursday?",
  "I have attached my notes, tell me if I missed anything.",
  "Let me know what suits and I will update the calendar.",
  "Priya raised a good point about timing, so we may want to wait.",
  "No rush on this, end of the week is fine.",
  "I spoke to the team this morning and they are happy to proceed.",
  "We can talk it through at the standup if that is easier.",
];
const PERSONAL_LINES = [
  "It was so good to see you at the weekend, the kids still talk about the beach.",
  "Mum asked if you can bring the big pot on Sunday.",
  "The vet says the dog is fine, just needs a softer diet for a while.",
  "We finally booked flights for the holidays, so send me your dates.",
  "Did you ever find that recipe for the lemon cake?",
];
const NEWSLETTER_ITEMS = [
  "Five ideas for your garden this autumn",
  "What our readers are cooking this month",
  "A short guide to fixing a slow laptop",
  "Meet the makers behind our new range",
  "Local events you will not want to miss",
  "Why small teams are moving away from spreadsheets",
];
const LIST_TOPICS = [
  "a patch for the parser crash on empty input",
  "whether to drop support for the old release next year",
  "the meeting notes from the working group",
  "a question about the build failing on arm machines",
];

type Campaign = {
  name: string;
  subject: string;
  lines: string[];
  site: string;
};

const CAMPAIGNS: Campaign[] = [
  {
    name: "pills",
    subject: "Cheap meds shipped overnight without prescription",
    lines: [
      "Order discount pharmacy pills online today with discreet overnight shipping.",
      "No prescription needed, lowest price guaranteed on every generic order.",
      "Huge savings on bestselling tablets, trusted by thousands of happy customers.",
      "Limited stock remaining, secure checkout, satisfaction guaranteed worldwide.",
    ],
    site: "cheapmeds-now.example",
  },
  {
    name: "crypto",
    subject: "Your crypto wallet earned guaranteed daily yield",
    lines: [
      "Join thousands earning guaranteed passive income with our crypto yield platform.",
      "Deposit today and watch your wallet double within thirty days, zero risk.",
      "Exclusive early investor bonus available only for registered members this week.",
      "Withdraw profits anytime, verified returns, expert traders managing everything.",
    ],
    site: "crypto-yield-pro.example",
  },
  {
    name: "seo",
    subject: "Rank number one on search engines this month",
    lines: [
      "Our search engine optimisation specialists noticed your website ranking poorly.",
      "We guarantee first page placement with affordable monthly backlink packages.",
      "Reply today for a complimentary website audit and competitor traffic report.",
      "Hundreds of businesses increased organic traffic using our proven methods.",
    ],
    site: "best-offer4u.example",
  },
  {
    name: "prize",
    subject: "Congratulations winner claim your cash prize now",
    lines: [
      "Your email address was selected as winner of our international lottery draw.",
      "Claim your cash prize immediately by confirming your banking details below.",
      "Unclaimed winnings expire soon, contact our claims agent without any delay.",
      "Processing fee applies, funds released directly into your nominated account.",
    ],
    site: "lucky-spin.example",
  },
];

const COLLEAGUES = ["Ana Lee", "Ben Park", "Chen Wood", "Dara Reid"];

const NOISE_WORDS =
  "lantern pebble orchard velvet thimble quartz marigold copper willow saffron tundra juniper".split(
    " ",
  );

const person = (random: Random) => `${random.pick(FIRST)} ${random.pick(LAST)}`;
const domain = (random: Random) =>
  `${random.pick(COMPANIES)}.${random.pick(TLDS)}`;
const local = (name: string) => name.toLowerCase().replace(/\s+/g, ".");

const PASS: Auth = { spf: "pass", dkim: "pass", dmarc: "pass" };
const UNSIGNED: Auth = { spf: "pass", dkim: "none", dmarc: "none" };

function authHeader(auth: Auth, fromDomain: string, signer = fromDomain) {
  return [
    "Authentication-Results: mx.cloudflare.net",
    `dkim=${auth.dkim}${auth.dkim === "none" ? "" : ` header.d=${signer}`}`,
    `dmarc=${auth.dmarc}${auth.policy ? ` (p=${auth.policy} dis=none)` : ""} header.from=${fromDomain}`,
    `spf=${auth.spf} smtp.mailfrom=${fromDomain}`,
  ].join("; ");
}

type Draft = {
  auth: Auth;
  fromName: string;
  fromAddress: string;
  signer?: string;
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  attachment?: string;
};

let serial = 0;

function render(draft: Draft): string {
  serial += 1;
  const fromDomain = draft.fromAddress.split("@")[1]!;
  const headers = [
    authHeader(draft.auth, fromDomain, draft.signer),
    `From: "${draft.fromName}" <${draft.fromAddress}>`,
    "To: Reception <reception@cloudysuite.example>",
    ...(draft.replyTo ? [`Reply-To: ${draft.replyTo}`] : []),
    `Subject: ${draft.subject}`,
    "Date: Mon, 02 Nov 2026 10:00:00 +0000",
    `Message-ID: <corpus-${serial}@${fromDomain}>`,
    "MIME-Version: 1.0",
  ];
  const body = draft.html
    ? ["Content-Type: text/html; charset=utf-8", "", draft.html]
    : ["Content-Type: text/plain; charset=utf-8", "", draft.text ?? ""];
  if (!draft.attachment) return [...headers, ...body].join("\r\n");
  return [
    ...headers,
    'Content-Type: multipart/mixed; boundary="part"',
    "",
    "--part",
    ...body,
    "--part",
    `Content-Type: application/octet-stream; name="${draft.attachment}"`,
    `Content-Disposition: attachment; filename="${draft.attachment}"`,
    "",
    "AAAA",
    "--part--",
  ].join("\r\n");
}

const trackedNewsletter = (random: Random, brand: string, site: string) =>
  `<html><body><h1>${random.pick(NEWSLETTER_ITEMS)}</h1><p>${random.pick(NEWSLETTER_ITEMS)}.</p>` +
  `<a href="https://click.mailservice.example/t/${random.between(1000, 9999)}">www.${site}</a>` +
  `<p>You signed up at ${brand}. <a href="https://click.mailservice.example/u">Unsubscribe</a></p></body></html>`;

const HAM_KINDS: Record<
  string,
  { share: number; make: (random: Random) => Draft }
> = {
  "work mail, signed": {
    share: 30,
    make: (random) => {
      const name = person(random);
      const site = domain(random);
      return {
        auth: PASS,
        fromName: name,
        fromAddress: `${local(name)}@${site}`,
        subject: `Re: ${random.pick(WORK_TOPICS).split(" ").slice(1, 5).join(" ")}`,
        text: `Hi,\n\nA note about ${random.pick(WORK_TOPICS)}.\n${random.pick(WORK_LINES)}\n${random.pick(WORK_LINES)}\n\n${name}`,
      };
    },
  },
  "personal mail, big provider": {
    share: 12,
    make: (random) => {
      const name = person(random);
      const site = random.pick(FREEMAIL);
      return {
        auth: PASS,
        fromName: name,
        fromAddress: `${local(name)}${random.between(1, 99)}@${site}`,
        subject: random.pick([
          "Sunday",
          "quick question",
          "photos",
          "holiday plans",
          "the dog",
        ]),
        text: `${random.pick(PERSONAL_LINES)}\n${random.pick(PERSONAL_LINES)}\n\nx`,
      };
    },
  },
  "new customer, small domain with no signing": {
    share: 12,
    make: (random) => {
      const name = person(random);
      const site = domain(random);
      return {
        auth: UNSIGNED,
        fromName: name,
        fromAddress: `${local(name)}@${site}`,
        subject: random.pick([
          "Enquiry about your services",
          "Do you have availability?",
          "Quote please",
          "URGENT QUOTE NEEDED TODAY",
        ]),
        text: `Hello, I found your details through a friend and wanted to ask about ${random.pick(WORK_TOPICS)}. Could someone call me? Thanks, ${name}`,
      };
    },
  },
  "newsletter with click tracking and another reply address": {
    share: 14,
    make: (random) => {
      const brand = random.pick(COMPANIES);
      const site = `${brand}.com`;
      return {
        auth: PASS,
        fromName: `${brand} news`,
        fromAddress: `news@${site}`,
        replyTo: `support@helpdesk.mailservice.example`,
        subject: random.pick(NEWSLETTER_ITEMS),
        html: trackedNewsletter(random, brand, site),
      };
    },
  },
  "receipt or notice in capitals from a service": {
    share: 8,
    make: (random) => {
      const brand = random.pick(COMPANIES);
      return {
        auth: PASS,
        fromName: `${brand} billing`,
        fromAddress: `billing@${brand}.com`,
        replyTo: `accounts@billing-provider.example`,
        subject: random.pick([
          "INVOICE ATTACHED FOR YOUR ACCOUNT",
          "PAYMENT RECEIVED THANK YOU",
          "Your receipt",
        ]),
        text: `Thanks for your payment of $${random.between(20, 900)}. Your invoice is attached.`,
        attachment: "invoice.pdf",
      };
    },
  },
  "mail forwarded from another account, so SPF fails": {
    share: 6,
    make: (random) => {
      const name = person(random);
      const site = domain(random);
      return {
        auth: { spf: "fail", dkim: "pass", dmarc: "pass" },
        fromName: name,
        fromAddress: `${local(name)}@${site}`,
        subject: "Fwd: the notes",
        text: `${random.pick(WORK_LINES)} ${random.pick(WORK_LINES)}`,
      };
    },
  },
  "mailing list that changes the message, with its own From": {
    share: 6,
    make: (random) => {
      const name = person(random);
      return {
        auth: { spf: "pass", dkim: "fail", dmarc: "none" },
        fromName: `${name} via devs`,
        fromAddress: "devs@lists.opensource.example",
        replyTo: "devs@lists.opensource.example",
        subject: `[devs] ${random.pick(LIST_TOPICS)}`,
        text: `I wanted to raise ${random.pick(LIST_TOPICS)}. ${random.pick(WORK_LINES)}`,
      };
    },
  },
  "mailing list keeping an author's From, breaking its checks": {
    share: 2,
    make: (random) => {
      const name = person(random);
      const site = domain(random);
      return {
        auth: { spf: "softfail", dkim: "fail", dmarc: "none" },
        fromName: name,
        fromAddress: `${local(name)}@${site}`,
        replyTo: "devs@lists.opensource.example",
        subject: `[devs] ${random.pick(LIST_TOPICS)}`,
        text: `Replying about ${random.pick(LIST_TOPICS)}. ${random.pick(WORK_LINES)}`,
      };
    },
  },
  "service sending in a person's name": {
    share: 4,
    make: (random) => {
      const name = person(random);
      const site = domain(random);
      return {
        auth: PASS,
        fromName: `${local(name)}@${site} via Docs`,
        fromAddress: "comments-noreply@docs.example",
        replyTo: `${local(name)}@${site}`,
        subject: "A document was shared with you",
        text: `${name} commented on the document: ${random.pick(WORK_LINES)}`,
      };
    },
  },
  "known colleague sending a script": {
    share: 2,
    make: (random) => {
      const name = random.pick(COLLEAGUES);
      return {
        auth: PASS,
        fromName: name,
        fromAddress: `${local(name)}@colleagues.example`,
        subject: "The script I mentioned",
        text: "Here is the small script that tidies the report.",
        attachment: "tidy-report.js",
      };
    },
  },
  // Real mail that fails DMARC where the domain asked for nothing, which is what
  // Cloudflare lets through. These stay in the false positive count.
  "vendor whose real mail fails DMARC under p=none": {
    share: 3,
    make: (random) => {
      const name = person(random);
      const site = domain(random);
      return {
        auth: { spf: "pass", dkim: "none", dmarc: "fail", policy: "none" },
        fromName: name,
        fromAddress: `${local(name)}@${site}`,
        subject: "Invoice for last month",
        text: `Please find the details of last month's work. ${random.pick(WORK_LINES)}`,
      };
    },
  },
  "vendor on a mail service, failing DMARC under p=none, with tracked links": {
    share: 3,
    make: (random) => {
      const brand = random.pick(COMPANIES);
      const site = `${brand}.com`;
      return {
        auth: { spf: "pass", dkim: "pass", dmarc: "fail", policy: "none" },
        signer: "mailservice.example",
        fromName: `${brand} news`,
        fromAddress: `news@${site}`,
        replyTo: "support@helpdesk.mailservice.example",
        subject: random.pick(NEWSLETTER_ITEMS),
        html: trackedNewsletter(random, brand, site),
      };
    },
  },
  "mailing list keeping an author's From, failing DMARC under p=none": {
    share: 3,
    make: (random) => {
      const name = person(random);
      const site = domain(random);
      return {
        auth: { spf: "softfail", dkim: "fail", dmarc: "fail", policy: "none" },
        fromName: name,
        fromAddress: `${local(name)}@${site}`,
        replyTo: "devs@lists.opensource.example",
        subject: `[devs] ${random.pick(LIST_TOPICS)}`,
        text: `Replying about ${random.pick(LIST_TOPICS)}. ${random.pick(WORK_LINES)}`,
      };
    },
  },
  "forwarded and changed on the way, failing DMARC with no policy stated": {
    share: 2,
    make: (random) => {
      const name = person(random);
      const site = domain(random);
      return {
        auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
        fromName: name,
        fromAddress: `${local(name)}@${site}`,
        subject: "Fwd: the notes",
        text: `${random.pick(WORK_LINES)} ${random.pick(WORK_LINES)}`,
      };
    },
  },
  // Real mail the filter is told to treat as spam. These are the false positives the
  // decisions to file a failure under an enforcing policy and a program from a stranger
  // accept, so they stay in the count.
  "stranger with a signed message sending a script": {
    share: 1,
    make: (random) => {
      const name = person(random);
      return {
        auth: PASS,
        fromName: name,
        fromAddress: `${local(name)}@${domain(random)}`,
        subject: "The script I mentioned",
        text: "Here is the small script that tidies the report.",
        attachment: "tidy-report.js",
      };
    },
  },
  "mailing list breaking a strict sender's DMARC": {
    share: 1,
    make: (random) => {
      const name = person(random);
      const site = domain(random);
      return {
        auth: {
          spf: "softfail",
          dkim: "fail",
          dmarc: "fail",
          policy: "quarantine",
        },
        fromName: name,
        fromAddress: `${local(name)}@${site}`,
        subject: `[devs] ${random.pick(LIST_TOPICS)}`,
        text: `Replying about ${random.pick(LIST_TOPICS)}.`,
      };
    },
  },
};

const phishPage = (random: Random, brand: string) =>
  `<html><body><p>Dear customer, your ${brand} account will be suspended. Verify now.</p>` +
  `<a href="http://${random.pick(THROWAWAY)}.example/login">https://www.${brand}.com/verify</a></body></html>`;

function campaignMail(random: Random, campaign: Campaign, auth: Auth): Draft {
  const sender = `${random.pick(["offers", "sales", "info", "team"])}@${campaign.site}`;
  // Each copy drops a line and adds noise, as bulk senders do to look different.
  const lines = campaign.lines
    .toSorted(() => random.next() - 0.5)
    .slice(1)
    .concat(
      NOISE_WORDS.toSorted(() => random.next() - 0.5)
        .slice(0, 4)
        .join(" "),
    );
  return {
    auth,
    fromName: campaign.name,
    fromAddress: sender,
    subject: campaign.subject,
    text: lines.join("\n"),
  };
}

const SPAM_KINDS: Record<
  string,
  { share: number; make: (random: Random) => Draft; campaign?: boolean }
> = {
  "phishing forging a real company, DMARC fails under p=quarantine": {
    share: 12,
    make: (random) => {
      const brand = random.pick(COMPANIES);
      return {
        auth: {
          spf: "fail",
          dkim: "none",
          dmarc: "fail",
          policy: "quarantine",
        },
        fromName: `${brand} security`,
        fromAddress: `security@${brand}.com`,
        subject: "Action required on your account",
        html: phishPage(random, brand),
      };
    },
  },
  "phishing forging a p=none company, with a misleading link": {
    share: 6,
    make: (random) => {
      const brand = random.pick(COMPANIES);
      return {
        auth: { spf: "softfail", dkim: "none", dmarc: "fail", policy: "none" },
        fromName: `${brand} security`,
        fromAddress: `security@${brand}.com`,
        subject: "Action required on your account",
        html: phishPage(random, brand),
      };
    },
  },
  // Nothing tells this from a real vendor with a half-set record, so it is missed.
  "plain forgery of a p=none company, replies going to free mail": {
    share: 4,
    make: (random) => {
      const brand = random.pick(COMPANIES);
      return {
        auth: { spf: "fail", dkim: "none", dmarc: "fail", policy: "none" },
        fromName: `${brand} accounts`,
        fromAddress: `accounts@${brand}.com`,
        replyTo: `accounts${random.between(1, 99)}@${random.pick(FREEMAIL)}`,
        subject: "New bank details for your next payment",
        text: "We have changed banks. Please reply to confirm before your next payment.",
      };
    },
  },
  "phishing from a lookalike domain that passes every check": {
    share: 14,
    make: (random) => {
      const brand = random.pick(COMPANIES);
      return {
        auth: PASS,
        fromName: `support@${brand}.com`,
        fromAddress: `alert@${brand}-secure.example`,
        replyTo: `help@${random.pick(FREEMAIL)}`,
        subject: "Your account has been limited",
        html: phishPage(random, brand),
      };
    },
  },
  "malware attachment from a stranger": {
    share: 10,
    make: (random) => ({
      auth: UNSIGNED,
      fromName: person(random),
      fromAddress: `${random.pick(["accounts", "hr", "admin"])}@${domain(random)}`,
      subject: "Overdue invoice attached",
      text: "Please open the attached file to see your overdue invoice.",
      attachment: `invoice-${random.between(100, 999)}.pdf.${random.pick(["exe", "scr", "js", "vbs"])}`,
    }),
  },
  "advance-fee scam with replies going to free mail": {
    share: 12,
    make: (random) => ({
      auth: { spf: "softfail", dkim: "none", dmarc: "none" },
      fromName: `Barrister ${person(random)}`,
      fromAddress: `office@${random.pick(THROWAWAY)}.example`,
      replyTo: `barrister${random.between(1, 99)}@${random.pick(FREEMAIL)}`,
      subject: "CONFIDENTIAL BUSINESS PROPOSAL",
      text: "I am a barrister representing the estate of a late client with no heirs. I need your help to move funds, for a share of the total.",
    }),
  },
  "bulk offer from a throwaway domain with tricks": {
    share: 14,
    make: (random) => {
      const site = `${random.pick(THROWAWAY)}.example`;
      return {
        auth: { spf: "softfail", dkim: "fail", dmarc: "none" },
        fromName: "Deals",
        fromAddress: `deals@${site}`,
        replyTo: `orders@${random.pick(THROWAWAY)}-mail.example`,
        subject: "HUGE SAVINGS ENDING TONIGHT ONLY",
        html: `<html><body><p>Everything must go!</p><a href="http://${site}/buy">www.amazon.com</a></body></html>`,
      };
    },
  },
  // Repeats of the campaigns below are what a person's marks teach the filter.
  "campaign mail that passes every check, with nothing odd about it": {
    share: 32,
    campaign: true,
    make: (random) => campaignMail(random, random.pick(CAMPAIGNS), PASS),
  },
};

function weighted<Kind extends { share: number }>(
  random: Random,
  kinds: Record<string, Kind>,
): [string, Kind] {
  const entries = Object.entries(kinds);
  const total = entries.reduce((sum, [, kind]) => sum + kind.share, 0);
  let roll = random.next() * total;
  for (const entry of entries) {
    roll -= entry[1].share;
    if (roll <= 0) return entry;
  }
  return entries.at(-1)!;
}

export function buildCorpus(
  seed: number,
  size: { ham: number; spam: number },
): CorpusMessage[] {
  const random = randomFrom(seed);
  const messages: CorpusMessage[] = [];
  for (let index = 0; index < size.ham; index += 1) {
    const [kind, { make }] = weighted(random, HAM_KINDS);
    messages.push({
      label: "ham",
      kind,
      campaign: null,
      raw: render(make(random)),
    });
  }
  for (let index = 0; index < size.spam; index += 1) {
    const [kind, { make, campaign }] = weighted(random, SPAM_KINDS);
    const draft = make(random);
    messages.push({
      label: "spam",
      kind,
      campaign: campaign ? draft.fromName : null,
      raw: render(draft),
    });
  }
  return messages;
}

// One campaign's messages, for teaching the model as a person would by marking them.
export function campaignExamples(
  seed: number,
  name: string,
  count: number,
): string[] {
  const random = randomFrom(seed);
  const campaign = CAMPAIGNS.find((one) => one.name === name)!;
  return Array.from({ length: count }, () =>
    render(campaignMail(random, campaign, PASS)),
  );
}

export const CAMPAIGN_NAMES = CAMPAIGNS.map((one) => one.name);

// Mail from the colleagues above, so they are people this mailbox has heard from.
export function introductions(): string[] {
  return COLLEAGUES.map((name) =>
    render({
      auth: PASS,
      fromName: name,
      fromAddress: `${local(name)}@colleagues.example`,
      subject: "Welcome aboard",
      text: "Good to have you on the team.",
    }),
  );
}

// A wave of spam that reads like the real invoices above, for checking what marks of
// it do to real mail that shares its words.
export function invoiceScamExamples(seed: number, count: number): string[] {
  const random = randomFrom(seed);
  return Array.from({ length: count }, () =>
    render({
      auth: PASS,
      fromName: "Accounts",
      fromAddress: `accounts@${random.pick(THROWAWAY)}.example`,
      subject: "Your invoice for payment attached",
      text: "Thanks for your payment. Your invoice is attached. The account shows an overdue balance, so please arrange payment of the attached invoice to our new bank account as soon as you can. Contact accounts with any questions about this invoice or your payment.",
    }),
  );
}

// Real invoices and notes that share those words.
export function realInvoices(seed: number, count: number): string[] {
  const random = randomFrom(seed);
  return Array.from({ length: count }, () => {
    const brand = random.pick(COMPANIES);
    return render({
      auth: random.pick([PASS, UNSIGNED]),
      fromName: `${brand} accounts`,
      fromAddress: `accounts@${brand}.com`,
      subject: random.pick([
        "Your invoice attached",
        "Invoice for payment",
        "Payment received",
      ]),
      text: `Thanks for your payment of $${random.between(20, 900)}. Your invoice is attached, and your account now shows a balance of $${random.between(0, 90)}. ${random.pick(WORK_LINES)} Contact accounts with any questions about this invoice.`,
    });
  });
}
