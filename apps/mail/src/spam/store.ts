import { readableText } from "../parse";
import type { SqlDriver } from "@cloudysuite/object-sql";
import type { AuthResults, Folder, MessageId, NewMessage } from "../types";
import {
  acceptedLinksIn,
  addressShownInName,
  dmarcEnforced,
  domainOf,
  forgeryEvidence,
  isAccepted,
  isShouting,
  provedDomain,
  replyDomainElsewhere,
  runnableFilename,
} from "./signals";
import { SCAN_CHARS, tokensOf } from "./tokens";
import {
  MAX_SENDER_ENTRIES,
  type MisleadingLink,
  opinionCanCount,
  parseStoredVerdict,
  REASON_POINTS,
  type SenderEntry,
  type SenderList,
  type SenderWrite,
  SPAM_THRESHOLD,
  type SpamReason,
  type SpamTraining,
  type SpamVerdict,
} from "./types";

// Learning stays off until there is this much to learn from. "Not spam" is rarer and
// is a person correcting a mistake, so it takes less to count.
export const MIN_SPAM_SAMPLES = 5;
export const MIN_HAM_SAMPLES = 3;

// A message is judged only on tokens the model has seen, so these bars ask that most
// of it was seen, and that those tokens lean one way by a clear margin.
const MIN_TOKENS_TO_JUDGE = 10;
const MIN_COVERAGE = 0.85;
const MIN_MEAN_EVIDENCE = 1;

// What a token's rate is assumed to be before there is evidence. With few samples of
// real mail this keeps a word from looking like spam just because no one has marked a
// real message with it yet.
const SMOOTHING = 0.5;
const PRIOR_DOCS = 10;
// Spam comes in unrelated waves, and marks of one wave must not dilute what was learned
// from another. Up to this many marked messages, a word needs about 4 marks to lean
// towards spam, however many others there are. Past it, the bar rises with the total,
// because in a big enough pile of spam, ordinary words have 4 marks too.
const SPAM_DOCS_FLOOR = 20;
const SPAM_DOCS_SHARE = 0.2;
// One "Not spam" outweighs many spam marks of the same kind, because real mail in
// Spam costs more than spam in the Inbox.
const HAM_WEIGHT = 5;

// About 16 bytes a row, so the model stays under about 500 KB. Pruning takes it well
// below the cap, so it does not run on every mark. The rarest and oldest tokens go
// first, because they have the least evidence behind them.
export const MAX_MODEL_TOKENS = 20_000;
const PRUNE_TO_TOKENS = 16_000;

export const MAX_CONTACTS = 20_000;
const PRUNE_TO_CONTACTS = 16_000;

// A conversation can hold any number of messages, and this all runs in one
// transaction that blocks the mailbox.
const MAX_TRAINED_PER_MOVE = 200;

const MAX_HTML_FOR_TOKENS = 8 * SCAN_CHARS;
const MAX_PARENT_DOMAINS = 10;
const MAX_ACCEPTED_PER_SENDER = 20;
export const MAX_ACCEPTED_LINKS = 2000;

// From the end, so a long run of subdomains can't push the real domain out.
function domainAndParents(domain: string): string[] {
  const labels = domain.split(".");
  return labels
    .map((_, index) => labels.slice(index).join("."))
    .filter((one) => one.includes("."))
    .slice(-MAX_PARENT_DOMAINS);
}

const isLive = (folder: Folder) => folder === "inbox" || folder === "archive";

// A person's move is what teaches the model, and the same table reverses it. So undo,
// or "Not spam" on a message someone marked, leaves the counts as they were before.
// Moving from Trash back to Spam, which undoing a Trash move does, teaches nothing.
export function nextTraining(
  trained: SpamTraining | null,
  from: Folder,
  to: Folder,
): SpamTraining | null {
  if (to === "spam" && isLive(from)) return trained === "ham" ? null : "spam";
  if (from === "spam" && isLive(to)) return trained === "spam" ? null : "ham";
  if (isLive(to) && trained === "spam") return null;
  return trained;
}

type TokenCounts = { token: number; spam: number; ham: number };
type Documents = { spam: number; ham: number };

function learnedLean(
  tokens: readonly number[],
  counts: readonly TokenCounts[],
  docs: Documents,
): "spam" | "real" | null {
  if (tokens.length < MIN_TOKENS_TO_JUDGE) return null;
  const spamDocs = Math.max(SPAM_DOCS_FLOOR, docs.spam * SPAM_DOCS_SHARE);
  const spamRate = (spam: number) =>
    (spam + SMOOTHING) / (spamDocs + PRIOR_DOCS);
  const hamRate = (ham: number) =>
    Math.min(1, (HAM_WEIGHT * ham + SMOOTHING) / (docs.ham + PRIOR_DOCS));
  let evidence = 0;
  let seenInSpam = 0;
  let seenInHam = 0;
  for (const { spam, ham } of counts) {
    evidence += Math.log(spamRate(spam) / hamRate(ham));
    if (spam > 0) seenInSpam += 1;
    if (ham > 0) seenInHam += 1;
  }
  const mean = evidence / tokens.length;
  if (
    docs.spam >= MIN_SPAM_SAMPLES &&
    seenInSpam / tokens.length >= MIN_COVERAGE &&
    mean >= MIN_MEAN_EVIDENCE
  ) {
    return "spam";
  }
  if (
    docs.ham >= MIN_HAM_SAMPLES &&
    seenInHam / tokens.length >= MIN_COVERAGE &&
    mean <= -MIN_MEAN_EVIDENCE
  ) {
    return "real";
  }
  return null;
}

export const RULE_MOVED: SpamVerdict = {
  spam: false,
  score: 0,
  reasons: [{ kind: "movedByRule" }],
};

const CLEAN: SpamVerdict = { spam: false, score: 0, reasons: [] };

type TrainingRow = {
  id: number;
  source: string;
  subject: string | null;
  snippet: string;
  from_name: string | null;
  from_address: string | null;
  auth_results: string | null;
  spam_verdict: string | null;
  spam_training: SpamTraining | null;
};

type ContactRow = { vouched: number };

export class SpamStore {
  readonly #db: SqlDriver;

  constructor(db: SqlDriver) {
    this.#db = db;
  }

  listSenders(): SenderEntry[] {
    return this.#db
      .exec<SenderEntry>(
        "SELECT pattern, list FROM spam_senders ORDER BY pattern",
      )
      .toArray();
  }

  // One sender is on one list, so adding it to the other list moves it.
  addSender(pattern: string, list: SenderList): SenderWrite {
    return this.#db.transaction(() => {
      const [row] = this.#db
        .exec<{ total: number; present: number }>(
          `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE pattern = ?) AS present
           FROM spam_senders`,
          pattern,
        )
        .toArray();
      if (row!.present === 0 && row!.total >= MAX_SENDER_ENTRIES) {
        return {
          ok: false,
          status: 409,
          message: `A mailbox can list up to ${MAX_SENDER_ENTRIES} senders. Remove one you don't need, then try again.`,
        };
      }
      this.#db.exec(
        `INSERT INTO spam_senders (pattern, list, created_at) VALUES (?, ?, ?)
         ON CONFLICT (pattern) DO UPDATE SET list = excluded.list`,
        pattern,
        list,
        Date.now(),
      );
      return { ok: true, entry: { pattern, list } };
    });
  }

  removeSender(pattern: string): void {
    this.#db.exec("DELETE FROM spam_senders WHERE pattern = ?", pattern);
  }

  #entriesFor(candidates: readonly string[]): SenderEntry[] {
    const rows = this.#db
      .exec<SenderEntry>(
        "SELECT pattern, list FROM spam_senders WHERE pattern IN (SELECT value FROM json_each(?))",
        JSON.stringify(candidates),
      )
      .toArray();
    return candidates.flatMap(
      (candidate) => rows.find((row) => row.pattern === candidate) ?? [],
    );
  }

  // Narrowest first, so one trusted address can sit inside a blocked domain, and one
  // blocked address inside an allowed domain.
  #listEntriesFor(address: string): SenderEntry[] {
    return this.#entriesFor([address, ...domainAndParents(domainOf(address))]);
  }

  #allowedDomainAmong(domains: readonly string[]): SenderEntry | null {
    return (
      this.#entriesFor(domains.flatMap(domainAndParents)).find(
        (entry) => entry.list === "allow",
      ) ?? null
    );
  }

  #contact(address: string): ContactRow | null {
    const [row] = this.#db
      .exec<ContactRow>(
        "SELECT vouched FROM spam_contacts WHERE address = ?",
        address,
      )
      .toArray();
    return row ?? null;
  }

  #acceptedLinks(address: string | null): MisleadingLink[] {
    if (address === null) return [];
    return this.#db
      .exec<MisleadingLink>(
        "SELECT shown, actual FROM spam_accepted_links WHERE address = ?",
        address,
      )
      .toArray();
  }

  // Only a Message-ID this mailbox wrote counts, not one it only received, because
  // anyone can reference mail they sent here themselves.
  #repliesToSent(references: readonly string[]): boolean {
    if (references.length === 0) return false;
    return (
      this.#db
        .exec(
          `SELECT 1 FROM thread_refs r
           JOIN messages m ON m.thread_id = r.thread_id AND m.rfc_message_id = r.rfc_id
           WHERE r.rfc_id IN (SELECT value FROM json_each(?)) AND m.source = 'sent'
           LIMIT 1`,
          JSON.stringify(references),
        )
        .toArray().length > 0
    );
  }

  #documents(): Documents {
    const [row] = this.#db
      .exec<{ spam_docs: number; ham_docs: number }>(
        "SELECT spam_docs, ham_docs FROM spam_model WHERE id = 1",
      )
      .toArray();
    return { spam: row?.spam_docs ?? 0, ham: row?.ham_docs ?? 0 };
  }

  #learned(
    message: NewMessage,
    known: boolean,
    proved: string | null,
  ): "spam" | "real" | null {
    const docs = this.#documents();
    if (docs.spam < MIN_SPAM_SAMPLES && docs.ham < MIN_HAM_SAMPLES) return null;
    const tokens = tokensOf({
      subject: message.subject,
      text: message.searchBody,
      provedDomain: proved,
    });
    const counts = this.#db
      .exec<TokenCounts>(
        "SELECT token, spam, ham FROM spam_tokens WHERE token IN (SELECT value FROM json_each(?))",
        JSON.stringify(tokens),
      )
      .toArray();
    const lean = learnedLean(tokens, counts, docs);
    // Words can look alike by chance, and a proved sender this mailbox already deals
    // with is better evidence than they are. Marking a sender as spam stops it being
    // known, so a person can still teach the filter about one.
    return lean === "spam" && known && proved !== null ? null : lean;
  }

  // The order here is the promise made on the Senders page. A block entry that is the
  // narrowest match for the From line wins over everything. Then a person's trust: the
  // allow list and "Not spam" both keep a sender's mail out of Spam, and a From line
  // anyone can type earns that unless the message looks forged (see forgeryEvidence).
  // Only then the score.
  judge(message: NewMessage): SpamVerdict {
    const { from, authResults, spamFacts } = message;
    const address = from?.address.toLowerCase() ?? null;
    const entries = address ? this.#listEntriesFor(address) : [];
    const narrowest = entries[0];
    const proved = spamFacts?.ambiguousFrom
      ? null
      : provedDomain(authResults, from);
    const contact = address ? this.#contact(address) : null;

    const reasons: SpamReason[] = [];
    const links = spamFacts?.misleadingLinks ?? [];
    let accepted: MisleadingLink[] = [];
    let forged = false;
    if (narrowest?.list !== "block") {
      // A signature by an allowed domain is that domain's word, whatever From says,
      // which is how a list that signs its posts can be allowed.
      if (this.#allowedDomainAmong(authResults?.dkimPassDomains ?? [])) {
        return CLEAN;
      }
      const allowed = narrowest ?? null;
      const vouched = contact !== null && contact.vouched === 1;
      if (proved !== null && (allowed || vouched)) return CLEAN;
      const listEntry = spamFacts?.listDomain
        ? this.#allowedDomainAmong([spamFacts.listDomain])
        : null;
      const trusted: SpamReason | null = allowed
        ? { kind: "allowNotProved", entry: allowed.pattern }
        : vouched
          ? { kind: "markedRealNotProved", address: address! }
          : listEntry
            ? { kind: "allowNotProved", entry: listEntry.pattern }
            : null;
      if (trusted) {
        accepted = this.#acceptedLinks(address);
        const evidence = forgeryEvidence(message, accepted);
        if (evidence === null) return CLEAN;
        forged = evidence === "strong";
        reasons.push(trusted);
      }
    }

    // A wider block still holds for mail that looks forged, whatever narrower entry it
    // claims.
    const blocked = entries.find((one) => one.list === "block");
    if (blocked) reasons.push({ kind: "blocked", entry: blocked.pattern });
    const enforced = dmarcEnforced(authResults);
    if (enforced) reasons.push({ kind: "senderCheckFailed" });
    const hard = forged || blocked !== undefined || enforced;
    // Only a pass for the From line's own domain says these failures don't matter. Anyone
    // can pass with a signature for their own domain.
    if (authResults && proved === null) {
      if (authResults.spf === "fail")
        reasons.push({ kind: "serverNotAllowed" });
      if (authResults.spf === "softfail") {
        reasons.push({ kind: "serverNotListed" });
      }
      if (authResults.dmarc === "fail" && !enforced) {
        reasons.push({ kind: "senderCheckUnproved" });
      } else if (authResults.dkim === "fail") {
        reasons.push({ kind: "signatureBroken" });
      }
    }
    if (from) {
      const shown = addressShownInName(from);
      if (shown) reasons.push({ kind: "nameShowsOtherAddress", shown });
      const domain = replyDomainElsewhere(from, message.replyTo);
      if (domain) reasons.push({ kind: "replyGoesElsewhere", domain });
    }
    const known = contact !== null;
    if (from && !known) reasons.push({ kind: "firstContact" });
    const filename = runnableFilename(message.attachments);
    if (filename) reasons.push({ kind: "runnableAttachment", filename });
    // The reason names a link no one accepted, if there is one, because that is what
    // a person reading it needs to see.
    const lead = links.find((link) => !isAccepted(link, accepted)) ?? links[0];
    if (lead) {
      const others = links.filter((link) => link !== lead);
      reasons.push({
        kind: "linkShowsOtherSite",
        ...lead,
        ...(others.length > 0 ? { others } : {}),
      });
    }
    if (isShouting(message.subject)) reasons.push({ kind: "shouting" });
    const learned = this.#learned(message, known, proved);
    if (learned === "spam") reasons.push({ kind: "learnedSpam" });
    if (learned === "real") reasons.push({ kind: "learnedReal" });
    if (this.#repliesToSent(message.references)) {
      reasons.push({ kind: "replyToSent" });
    }
    if (spamFacts?.opinion?.spam && opinionCanCount(reasons)) {
      reasons.push({ kind: "opinion" });
    }

    const score = reasons.reduce(
      (total, reason) => total + REASON_POINTS[reason.kind],
      0,
    );
    return { spam: hard || score >= SPAM_THRESHOLD, score, reasons };
  }

  // A sender becomes known only by landing outside Spam, or by being written to.
  // Imported mail teaches nothing here either, so a file full of old spam can't vouch
  // for its senders.
  noteStored(message: NewMessage, folder: Folder): void {
    if (message.source === "import" || folder === "spam") return;
    const people =
      message.source === "sent"
        ? [...message.to, ...message.cc]
        : message.from
          ? [message.from]
          : [];
    // A throw here would fail the delivery, and this only tips a close call later.
    try {
      for (const person of people) {
        this.#rememberContact(person.address, message.receivedAt);
      }
    } catch (error) {
      console.error("Could not remember a sender. The message is kept.", error);
    }
  }

  #rememberContact(address: string, at: number): void {
    this.#db.exec(
      `INSERT INTO spam_contacts (address, last_at) VALUES (?, ?)
       ON CONFLICT (address) DO UPDATE SET last_at = MAX(last_at, excluded.last_at)`,
      address.toLowerCase(),
      at,
    );
    const [row] = this.#db
      .exec<{ total: number }>("SELECT COUNT(*) AS total FROM spam_contacts")
      .toArray();
    if (row!.total <= MAX_CONTACTS) return;
    this.#db.exec(
      `DELETE FROM spam_contacts WHERE address IN (
         SELECT address FROM spam_contacts ORDER BY vouched, last_at LIMIT ?
       )`,
      row!.total - PRUNE_TO_CONTACTS,
    );
  }

  // Someone took this sender's mail out of Spam. Whatever that message's links and name
  // pointed at is then the sender's own habit, so the next copy doesn't count as forged
  // for it, or every issue of that sender's newsletter would land back in Spam. Each row
  // names the message it came from, so undoing that move takes away exactly what the
  // move added, and moving a message twice adds nothing new.
  #vouchFor(address: string, id: number, verdict: string | null): void {
    const lower = address.toLowerCase();
    this.#rememberContact(lower, Date.now());
    this.#db.exec(
      "UPDATE spam_contacts SET vouched = 1 WHERE address = ?",
      lower,
    );
    const reasons = parseStoredVerdict(verdict)?.reasons ?? [];
    const now = Date.now();
    for (const { shown, actual } of acceptedLinksIn(reasons, lower)) {
      this.#db.exec(
        `INSERT OR IGNORE INTO spam_accepted_links
           (address, shown, actual, message_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        lower,
        shown,
        actual,
        id,
        now,
      );
    }
    this.#db.exec(
      `DELETE FROM spam_accepted_links WHERE address = ?1 AND message_id NOT IN (
         SELECT message_id FROM spam_accepted_links WHERE address = ?1
         ORDER BY created_at DESC, message_id DESC LIMIT ?2
       )`,
      lower,
      MAX_ACCEPTED_PER_SENDER,
    );
    this.#db.exec(
      `DELETE FROM spam_accepted_links WHERE message_id NOT IN (
         SELECT message_id FROM spam_accepted_links
         ORDER BY created_at DESC, message_id DESC LIMIT ?
       )`,
      MAX_ACCEPTED_LINKS,
    );
  }

  #forgetContact(address: string): void {
    this.#db.exec(
      "DELETE FROM spam_contacts WHERE address = ?",
      address.toLowerCase(),
    );
  }

  // The same text gives the same tokens at both ends of a mark and its undo, so the
  // counts go back exactly. A body kept in R2 can't be read in this transaction, so
  // that message teaches only its subject, sender, and opening words.
  #tokensOfStored(row: TrainingRow): number[] {
    const bodies = this.#db
      .exec<{ kind: "text" | "html"; content: string | null }>(
        "SELECT kind, substr(inline_content, 1, ?) AS content FROM message_bodies WHERE message_id = ?",
        MAX_HTML_FOR_TOKENS,
        row.id,
      )
      .toArray();
    const text = bodies.find((body) => body.kind === "text")?.content ?? null;
    const html = bodies.find((body) => body.kind === "html")?.content ?? null;
    const body =
      text !== null || html !== null
        ? readableText({ text, html })
        : row.snippet;
    return tokensOf({
      subject: row.subject,
      text: body,
      provedDomain: provedDomain(
        row.auth_results ? (JSON.parse(row.auth_results) as AuthResults) : null,
        row.from_address
          ? { name: row.from_name ?? "", address: row.from_address }
          : null,
      ),
    });
  }

  #count(tokens: number[], side: SpamTraining, change: 1 | -1): void {
    const delta = {
      spam: side === "spam" ? 1 : 0,
      ham: side === "ham" ? 1 : 0,
    };
    const json = JSON.stringify(tokens);
    if (change === 1) {
      this.#db.exec(
        `INSERT INTO spam_tokens (token, spam, ham, touched_at)
         SELECT value, ?, ?, ? FROM json_each(?) WHERE true
         ON CONFLICT (token) DO UPDATE SET
           spam = spam + excluded.spam,
           ham = ham + excluded.ham,
           touched_at = excluded.touched_at`,
        delta.spam,
        delta.ham,
        Date.now(),
        json,
      );
    } else {
      this.#db.exec(
        `UPDATE spam_tokens SET spam = MAX(spam - ?, 0), ham = MAX(ham - ?, 0)
         WHERE token IN (SELECT value FROM json_each(?))`,
        delta.spam,
        delta.ham,
        json,
      );
      this.#db.exec(
        `DELETE FROM spam_tokens
         WHERE spam = 0 AND ham = 0 AND token IN (SELECT value FROM json_each(?))`,
        json,
      );
    }
    this.#db.exec(
      `UPDATE spam_model
       SET spam_docs = MAX(spam_docs + ?1, 0), ham_docs = MAX(ham_docs + ?2, 0)
       WHERE id = 1`,
      delta.spam * change,
      delta.ham * change,
    );
  }

  #prune(): void {
    const [row] = this.#db
      .exec<{ total: number }>("SELECT COUNT(*) AS total FROM spam_tokens")
      .toArray();
    if (row!.total <= MAX_MODEL_TOKENS) return;
    this.#db.exec(
      `DELETE FROM spam_tokens WHERE token IN (
         SELECT token FROM spam_tokens ORDER BY spam + ham, touched_at LIMIT ?
       )`,
      row!.total - PRUNE_TO_TOKENS,
    );
  }

  // Runs in the transaction of the move it learns from, so the two can't disagree.
  noteMoves(moves: readonly { id: number; from: Folder; to: Folder }[]): void {
    const changed = moves.slice(0, MAX_TRAINED_PER_MOVE);
    if (!changed.some(({ from, to }) => from !== to)) return;
    const rows = new Map(
      this.#db
        .exec<TrainingRow>(
          `SELECT id, source, subject, snippet, from_name, from_address, auth_results,
                  spam_verdict, spam_training
           FROM messages WHERE id IN (SELECT value FROM json_each(?))`,
          JSON.stringify(changed.map(({ id }) => id)),
        )
        .toArray()
        .map((row) => [row.id, row]),
    );
    let trained = false;
    for (const { id, from, to } of changed) {
      const row = rows.get(id);
      // Your own words are not evidence about mail other people send.
      if (!row || row.source === "sent") continue;
      const next = nextTraining(row.spam_training, from, to);
      if (next === row.spam_training) continue;
      const tokens = this.#tokensOfStored(row);
      if (row.spam_training) this.#count(tokens, row.spam_training, -1);
      if (next) this.#count(tokens, next, 1);
      this.#db.exec(
        "UPDATE messages SET spam_training = ? WHERE id = ?",
        next,
        id as MessageId,
      );
      // The latest thing a person did about a sender decides, so undoing a mark puts
      // the trust back as well.
      if (row.from_address && to === "spam" && isLive(from)) {
        this.#forgetContact(row.from_address);
        this.#db.exec(
          "DELETE FROM spam_accepted_links WHERE message_id = ?",
          id,
        );
      }
      if (row.from_address && from === "spam" && isLive(to)) {
        this.#vouchFor(row.from_address, id, row.spam_verdict);
      }
      trained = true;
    }
    if (trained) this.#prune();
  }
}
