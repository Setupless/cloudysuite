import { expect, test } from "bun:test";
import {
  buildCorpus,
  CAMPAIGN_NAMES,
  type CorpusMessage,
  campaignExamples,
  introductions,
  invoiceScamExamples,
  realInvoices,
} from "../../scripts/spam-corpus";
import { ingest } from "../ingest";
import { MailboxStore } from "../store";
import { createTestEnv, MAILBOX_A, toArrayBuffer } from "../test-support";
import type { IngestResult, MessageRef } from "../types";

// The sizes and rates this prints are what the PR reports. Set SPAM_CORPUS_REPORT=1 to
// see them, and read the header of spam-corpus.ts before quoting them anywhere.
const TUNING_SEED = 20261101;
const HOLDOUT_SEED = 77;
const SIZE = { ham: 2000, spam: 2000 };

function freshMailbox() {
  const test = createTestEnv();
  const { db } = test.instanceOf(MAILBOX_A);
  const store = new MailboxStore(db);
  const deliver = async (raw: string) =>
    (await ingest(test.env, {
      source: "inbound",
      mailboxId: MAILBOX_A,
      raw: toArrayBuffer(raw),
      envelope: { from: "a@example.org", to: "reception@cloudysuite.example" },
    })) as Exclude<IngestResult, { status: "tooLarge" }>;
  return { db, store, deliver };
}

type Tally = { total: number; inSpam: number };

function report(title: string, tallies: Map<string, Tally>) {
  if (!process.env.SPAM_CORPUS_REPORT) return;
  console.log(`\n${title}`);
  for (const [kind, { total, inSpam }] of tallies) {
    console.log(
      `  ${inSpam}/${total} in Spam (${((100 * inSpam) / total).toFixed(1)}%)  ${kind}`,
    );
  }
}

async function run(
  corpus: CorpusMessage[],
  deliver: (raw: string) => Promise<MessageRef>,
) {
  const tallies = new Map<string, Tally>();
  const counts = {
    ham: { total: 0, inSpam: 0 },
    spam: { total: 0, inSpam: 0 },
  };
  for (const message of corpus) {
    const { folder } = await deliver(message.raw);
    const tally = tallies.get(`${message.label}: ${message.kind}`) ?? {
      total: 0,
      inSpam: 0,
    };
    tally.total += 1;
    counts[message.label].total += 1;
    if (folder === "spam") {
      tally.inSpam += 1;
      counts[message.label].inSpam += 1;
    }
    tallies.set(`${message.label}: ${message.kind}`, tally);
  }
  return { tallies, counts };
}

// Real mail the filter was told to file, by the decisions that every DMARC failure and
// every program from a stranger go to Spam. Anything else landing in Spam is a false
// positive this tuning must not make.
const FILED_BY_DECISION =
  /fails DMARC|breaking a strict sender's DMARC|stranger with a signed message sending a script/;

const wrongHam = (tallies: Map<string, Tally>) =>
  [...tallies]
    .filter(
      ([kind]) => kind.startsWith("ham:") && !FILED_BY_DECISION.test(kind),
    )
    .reduce((sum, [, tally]) => sum + tally.inSpam, 0);

for (const [name, seed] of [
  ["tuning", TUNING_SEED],
  ["held-out", HOLDOUT_SEED],
] as const) {
  test(`with nothing learned, the ${name} corpus files no real mail beyond DMARC failures`, async () => {
    const { deliver } = freshMailbox();
    for (const raw of introductions()) await deliver(raw);
    const { tallies, counts } = await run(buildCorpus(seed, SIZE), deliver);
    report(`No learning, seed ${seed}: ${JSON.stringify(counts)}`, tallies);
    expect(wrongHam(tallies)).toBe(0);
    expect(counts.spam.inSpam / counts.spam.total).toBeGreaterThan(0.5);
  }, 60_000);

  test(`after people mark campaigns, the ${name} corpus still files no other real mail and catches more`, async () => {
    const { store, deliver } = freshMailbox();
    for (const raw of introductions()) await deliver(raw);
    for (const campaign of CAMPAIGN_NAMES) {
      for (const raw of campaignExamples(seed + 1, campaign, 8)) {
        const { messageId } = await deliver(raw);
        store.moveToFolder({ messageIds: [messageId] }, "spam");
      }
    }
    const { tallies, counts } = await run(buildCorpus(seed, SIZE), deliver);
    report(
      `8 marks of each of ${CAMPAIGN_NAMES.length} campaigns, seed ${seed}: ${JSON.stringify(counts)}`,
      tallies,
    );
    expect(wrongHam(tallies)).toBe(0);
    expect(counts.spam.inSpam / counts.spam.total).toBeGreaterThan(0.8);
  }, 60_000);
}

test("marks of a scam that reads like real invoices don't file the real invoices", async () => {
  const { store, deliver } = freshMailbox();
  for (const raw of invoiceScamExamples(5, 30)) {
    const { messageId, folder } = await deliver(raw);
    if (folder !== "spam") {
      store.moveToFolder({ messageIds: [messageId] }, "spam");
    }
  }
  const scam = await deliver(invoiceScamExamples(6, 1)[0]!);
  const invoices = await Promise.all(realInvoices(7, 200).map(deliver));
  const filed = invoices.filter((one) => one.folder === "spam").length;
  if (process.env.SPAM_CORPUS_REPORT) {
    console.log(
      `\nReal invoices filed after marks of a lookalike scam: ${filed}/200`,
    );
  }
  expect(scam.folder).toBe("spam");
  expect(filed).toBe(0);
}, 60_000);

test("the corpus is the same every time for a seed", () => {
  const strip = (messages: CorpusMessage[]) =>
    messages.map((one) => one.raw.replace(/corpus-\d+/g, "corpus"));
  expect(strip(buildCorpus(1, { ham: 5, spam: 5 }))).toEqual(
    strip(buildCorpus(1, { ham: 5, spam: 5 })),
  );
});
