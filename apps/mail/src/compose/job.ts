import { assembleBodies } from "./body";
import { prepareSent } from "../ingest";
import { quoteHtmlKey, quoteTextKey, sentCopyPrefix } from "../r2-keys";
import type { Address } from "../types";
import type { DueJob, OutgoingStore } from "./store";
import {
  type OutgoingFile,
  type OutgoingMessage,
  storedCopyRaw,
  toEmailBuilder,
} from "./outgoing-message";
import { judgeSendError, retryDelay, storeRetryDelay } from "./send-outcome";
import { reasonNotToSend } from "./send-permission";
import type { OutgoingId, SendFailure } from "./types";

type SendEmailPort = {
  send(builder: EmailMessageBuilder): Promise<{ messageId: string }>;
};

class AttachmentGone extends Error {}

async function readFiles(
  bucket: R2Bucket,
  job: DueJob,
): Promise<OutgoingFile[]> {
  const files: OutgoingFile[] = [];
  for (const file of job.files) {
    const object = await bucket.get(file.r2_key);
    if (!object) throw new AttachmentGone();
    files.push({
      filename: file.filename,
      mimeType: file.mime_type,
      bytes: new Uint8Array(await object.arrayBuffer()),
    });
  }
  return files;
}

async function readQuote(bucket: R2Bucket, job: DueJob) {
  if (job.quote_bytes === null || job.include_quote === 0) return null;
  const [html, text] = await Promise.all([
    bucket.get(quoteHtmlKey(job.r2_prefix)),
    bucket.get(quoteTextKey(job.r2_prefix)),
  ]);
  if (!html || !text) throw new AttachmentGone();
  return { html: await html.text(), text: await text.text() };
}

async function messageOf(
  bucket: R2Bucket,
  job: DueJob,
): Promise<OutgoingMessage> {
  const files = await readFiles(bucket, job);
  const quote = await readQuote(bucket, job);
  const { html, text } = assembleBodies(
    { html: job.html, text: job.body_text },
    quote,
  );
  return {
    id: job.id as OutgoingId,
    from: { name: job.from_name, address: job.from_address },
    to: JSON.parse(job.to_addresses) as Address[],
    cc: JSON.parse(job.cc_addresses) as Address[],
    bcc: JSON.parse(job.bcc_addresses) as Address[],
    subject: job.subject,
    html,
    text,
    parent:
      job.parent_message_id === null
        ? null
        : {
            rfcMessageId: job.parent_rfc_id,
            references: JSON.parse(job.parent_refs) as string[],
          },
    files,
  };
}

function retryOrFail(
  outgoing: OutgoingStore,
  job: DueJob,
  failure: SendFailure,
  now: number,
): void {
  const delay = retryDelay(job.attempts);
  if (delay === null) outgoing.fail(job.id as OutgoingId, failure, now);
  else outgoing.postpone(job.id as OutgoingId, job.attempts + 1, now + delay);
}

// Nothing has gone out when this is called, and repeating it can send nothing. The copy
// has its own R2 prefix per job, so a repeat overwrites the same objects.
async function storeCopy(
  outgoing: OutgoingStore,
  bucket: R2Bucket,
  job: DueJob,
  now: number,
): Promise<void> {
  const id = job.id as OutgoingId;
  try {
    const message = await messageOf(bucket, job);
    const raw = storedCopyRaw(
      message,
      job.returned_message_id,
      job.accepted_at ?? now,
    );
    const copy = await prepareSent(bucket, {
      raw,
      prefix: sentCopyPrefix(job.r2_prefix),
    });
    outgoing.finish(id, copy, now);
  } catch (error) {
    console.error("Could not store a copy of a sent message yet.", error);
    outgoing.postponeStoring(
      id,
      job.attempts + 1,
      now + storeRetryDelay(job.attempts),
    );
  }
}

async function send(
  outgoing: OutgoingStore,
  bucket: R2Bucket,
  email: SendEmailPort,
  database: D1Database,
  saveProgress: () => Promise<void>,
  job: DueJob,
  now: number,
): Promise<void> {
  const id = job.id as OutgoingId;
  let message: OutgoingMessage;
  try {
    message = await messageOf(bucket, job);
  } catch (error) {
    if (error instanceof AttachmentGone) {
      outgoing.fail(id, "attachmentMissing", now);
    } else {
      console.error("Could not read a message's attachments yet.", error);
      retryOrFail(outgoing, job, "storageUnavailable", now);
    }
    return;
  }

  // After the file reads, which can be slow, so nothing changes unseen before the call.
  let refusal: SendFailure | null;
  try {
    refusal = await reasonNotToSend(database, {
      mailboxId: job.mailbox_id,
      senderId: job.sent_by,
      fromAddress: job.from_address,
    });
  } catch (error) {
    console.error("Could not check whether a message may still go.", error);
    retryOrFail(outgoing, job, "checkUnavailable", now);
    return;
  }
  if (refusal) {
    outgoing.fail(id, refusal, now);
    return;
  }

  if (!outgoing.claim(id, job.revision, now)) return;
  await saveProgress();

  let messageId: string;
  try {
    ({ messageId } = await email.send(toEmailBuilder(message)));
  } catch (error) {
    const outcome = judgeSendError(error);
    if (outcome.kind === "rejected") {
      outgoing.fail(id, outcome.failure, Date.now());
    } else if (outcome.kind === "temporary") {
      retryOrFail(outgoing, job, "rateLimited", Date.now());
    } else {
      console.error("A send ended without a clear answer.", error);
      outgoing.markUnknown(id, Date.now());
    }
    return;
  }

  const acceptedAt = Date.now();
  outgoing.accept(id, messageId, acceptedAt);
  await saveProgress();
  await storeCopy(
    outgoing,
    bucket,
    {
      ...job,
      returned_message_id: messageId,
      accepted_at: acceptedAt,
      attempts: 0,
    },
    acceptedAt,
  );
}

// Each step reads where the job stands and does only what is left, so a run after a
// crash at any point converges without a second send.
export async function runDueSends(
  outgoing: OutgoingStore,
  bucket: R2Bucket,
  email: SendEmailPort,
  database: D1Database,
  saveProgress: () => Promise<void>,
  now: number,
): Promise<void> {
  for (const job of outgoing.dueJobs(now)) {
    switch (job.state) {
      case "sending":
        // Alarm handlers don't overlap, so whoever claimed this is gone, and there is
        // no way to tell whether the service took the message first.
        outgoing.markUnknown(job.id as OutgoingId, now);
        break;
      case "scheduled":
        await send(outgoing, bucket, email, database, saveProgress, job, now);
        break;
      case "accepted":
        await storeCopy(outgoing, bucket, job, now);
        break;
      default:
        break;
    }
  }
}
