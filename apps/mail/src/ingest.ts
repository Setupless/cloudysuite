import type { MailboxId } from "@cloudysuite/access";
import { resolveRecipient } from "./address";
import { parseAuthenticationResults } from "./auth-results";
import {
  type ParsedAttachment,
  type ParsedMessage,
  parseMessage,
  readableText,
  snippetOf,
  truncateUtf8,
} from "./parse";
import { attachmentKey, bodyKey, newMessagePrefix, rawKey } from "./r2-keys";
import { mailboxStub } from "./stub";
import {
  BODY_INLINE_LIMIT_BYTES,
  type BodyKind,
  type IngestResult,
  MAX_MESSAGE_BYTES,
  type NewAttachment,
  type NewBody,
  type NewMessage,
} from "./types";

export type IngestInput = { mailboxId: MailboxId; raw: ArrayBuffer } & (
  | { source: "inbound"; envelope: { from: string; to: string } }
  | { source: "import" }
  | { source: "sent" }
);

const SEARCH_BODY_LIMIT_BYTES = 1024 * 1024;
const R2_PARALLEL_WRITES = 6;

async function storeBody(
  bucket: R2Bucket,
  prefix: string,
  kind: BodyKind,
  content: string,
): Promise<NewBody> {
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength <= BODY_INLINE_LIMIT_BYTES) {
    return { kind, size: bytes.byteLength, inline: content };
  }
  const r2Key = bodyKey(prefix, kind);
  await bucket.put(r2Key, bytes);
  return { kind, size: bytes.byteLength, r2Key };
}

async function storeAttachments(
  bucket: R2Bucket,
  prefix: string,
  attachments: ParsedAttachment[],
): Promise<NewAttachment[]> {
  const stored: NewAttachment[] = [];
  for (let start = 0; start < attachments.length; start += R2_PARALLEL_WRITES) {
    const batch = attachments.slice(start, start + R2_PARALLEL_WRITES);
    const results = await Promise.all(
      batch.map(async ({ content, ...attachment }, offset) => {
        const position = start + offset;
        const r2Key = attachmentKey(prefix, position);
        await bucket.put(r2Key, content);
        return { ...attachment, position, r2Key, size: content.byteLength };
      }),
    );
    stored.push(...results);
  }
  return stored;
}

async function storeObjects(
  bucket: R2Bucket,
  prefix: string,
  raw: ArrayBuffer,
  parsed: ParsedMessage,
): Promise<Pick<NewMessage, "bodies" | "attachments">> {
  await bucket.put(rawKey(prefix), raw);
  const bodies: NewBody[] = [];
  if (parsed.text !== null) {
    bodies.push(await storeBody(bucket, prefix, "text", parsed.text));
  }
  if (parsed.html !== null) {
    bodies.push(await storeBody(bucket, prefix, "html", parsed.html));
  }
  const attachments = await storeAttachments(
    bucket,
    prefix,
    parsed.attachments,
  );
  return { bodies, attachments };
}

// The only way a message enters a mailbox. Safe to repeat at every point: each
// attempt writes under its own prefix, and the row that makes the message visible
// goes in last, in one transaction, so it never points at a missing object. An
// attempt that fails while writing or loses to another copy queues its prefix for
// removal. One that dies outright leaves objects that nothing shows or removes, so
// parsing, the likeliest place to hit a Worker limit, runs before any write.
export async function ingest(
  env: Env,
  input: IngestInput,
): Promise<IngestResult> {
  const { mailboxId, raw } = input;
  if (raw.byteLength > MAX_MESSAGE_BYTES) return { status: "tooLarge" };

  const digest = await crypto.subtle.digest("SHA-256", raw);
  const rawHash = new Uint8Array(digest).toHex();
  const stub = mailboxStub(env, mailboxId);

  const existing = await stub.findByHash(rawHash);
  if (existing) return { status: "duplicate", ...existing } as IngestResult;

  const parsed = await parseMessage(raw);
  const prefix = newMessagePrefix(mailboxId);
  let objects: Awaited<ReturnType<typeof storeObjects>>;
  try {
    objects = await storeObjects(env.BUCKET, prefix, raw, parsed);
  } catch (error) {
    await stub.abandonUpload(prefix);
    throw error;
  }

  const now = Date.now();
  const text = readableText(parsed);
  const message: NewMessage = {
    rawHash,
    rawSize: raw.byteLength,
    r2Prefix: prefix,
    source: input.source,
    envelopeFrom: input.source === "inbound" ? input.envelope.from : null,
    envelopeTo: input.source === "inbound" ? input.envelope.to : null,
    parseStatus: parsed.status,
    rfcMessageId: parsed.rfcMessageId,
    references: parsed.references,
    subject: parsed.subject,
    from: parsed.from,
    replyTo: parsed.replyTo,
    to: parsed.to,
    cc: parsed.cc,
    snippet: snippetOf(text),
    sentAt: parsed.sentAt,
    // An imported message keeps its original date, and a forged future date must
    // not pin it to the top of a list.
    receivedAt:
      input.source === "import" ? Math.min(parsed.sentAt ?? now, now) : now,
    // Only Cloudflare's own verdict at delivery counts. The same header on an
    // imported or sent message says nothing we can trust.
    authResults:
      input.source === "inbound"
        ? parseAuthenticationResults(parsed.firstAuthenticationResults)
        : null,
    searchBody: truncateUtf8(text, SEARCH_BODY_LIMIT_BYTES),
    ...objects,
  };
  return (await stub.commit(message)) as IngestResult;
}

// What the Worker's email() handler runs. It does not check whether Mail is turned
// on, because a bounced message cannot be recovered later. Anything thrown here
// reaches the runtime, so that delivery fails rather than the message going missing.
export async function receiveInbound(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const mailboxId = await resolveRecipient(env.DB, message.to);
  if (!mailboxId) {
    message.setReject("There is no mailbox at this address.");
    return;
  }
  if (message.rawSize > MAX_MESSAGE_BYTES) {
    message.setReject("This message is larger than the 25 MB limit.");
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  const result = await ingest(env, {
    source: "inbound",
    mailboxId,
    raw,
    envelope: { from: message.from, to: message.to },
  });
  if (result.status === "tooLarge") {
    message.setReject("This message is larger than the 25 MB limit.");
  }
}
