import { prepareImported } from "../ingest";
import { importAttemptPrefix, importMessagePrefix } from "../r2-keys";
import type { MailboxStore } from "../store";
import { type MboxItem, type RangeReader, readMbox } from "./mbox";
import { isUploadGone } from "./r2-errors";
import type { FinishedBatch, ImportStore, JobRow } from "./store";
import type { UnreadableItem } from "./types";

// Sized so a batch stays far inside the Workers limits: 128 MB of memory shared by
// the isolate, 30 seconds of CPU, and 10,000 R2 calls, which local workerd does not
// enforce. A message over the byte budget always gets a batch of its own.
export const BATCH_LIMITS = {
  items: 50,
  bytes: 8 * 1024 * 1024,
  r2Writes: 300,
  wallMs: 8_000,
};

// A batch that dies again and again has hit something the runtime will not
// tolerate. Narrow it to one message, then list that message and move on, so one
// bad message cannot stop the import for good.
const CRASHES_BEFORE_ONE_MESSAGE = 2;
const CRASHES_BEFORE_SKIPPING = 4;
const SKIPPING_MESSAGE_LIMIT = 64 * 1024;

class FileMissing extends Error {}

const rangeReader =
  (bucket: R2Bucket, key: string): RangeReader =>
  async (offset, length) => {
    const object = await bucket.get(key, { range: { offset, length } });
    if (!object) throw new FileMissing();
    return new Uint8Array(await object.arrayBuffer());
  };

function asUnreadable(
  item: Extract<MboxItem, { kind: "unreadable" }>,
): UnreadableItem {
  return {
    offset: item.start,
    size: item.size,
    reason: item.reason,
    hint: item.hint,
  };
}

async function runBatch(
  imports: ImportStore,
  mail: MailboxStore,
  bucket: R2Bucket,
  saveBatchStart: () => Promise<void>,
  job: JobRow,
): Promise<void> {
  const attempt = crypto.randomUUID();
  const plan = imports.beginBatch(job.id, attempt);
  if (!plan) return;
  // The attempt and the alarm that retries it must be durable before R2 holds
  // anything that only the attempt can name.
  await saveBatchStart();

  const skippingMessages = plan.crashes >= CRASHES_BEFORE_SKIPPING;
  const maxItems =
    plan.crashes >= CRASHES_BEFORE_ONE_MESSAGE ? 1 : BATCH_LIMITS.items;
  const attemptPrefix = importAttemptPrefix(job.mailbox_id, attempt);
  const startedAt = Date.now();
  const batch: FinishedBatch = {
    messages: [],
    duplicates: 0,
    unreadable: [],
    position: plan.position,
    abandoned: [],
    outcome: "endOfFile",
  };
  let items = 0;
  let bytes = 0;
  let r2Writes = 0;
  const budgetSpent = () =>
    items >= maxItems ||
    bytes >= BATCH_LIMITS.bytes ||
    r2Writes >= BATCH_LIMITS.r2Writes ||
    Date.now() - startedAt >= BATCH_LIMITS.wallMs;

  let prefix: string | null = null;
  try {
    for await (const item of readMbox(
      rangeReader(bucket, job.r2_key),
      job.size,
      plan.position,
      skippingMessages ? SKIPPING_MESSAGE_LIMIT : undefined,
    )) {
      if (item.kind === "notMbox") {
        imports.failBatch(job.id, attempt, "notMbox");
        return;
      }
      if (item.kind === "skipping") {
        batch.position = item.next;
      } else if (item.kind === "unreadable") {
        batch.unreadable.push(
          skippingMessages
            ? { ...asUnreadable(item), reason: "couldNotProcess" }
            : asUnreadable(item),
        );
        batch.position = item.next;
        items += 1;
      } else if (skippingMessages) {
        batch.unreadable.push({
          offset: item.start,
          size: item.raw.byteLength,
          reason: "couldNotProcess",
          hint: "",
        });
        batch.position = item.next;
        items += 1;
      } else {
        // Holding the next large message beside a full batch is what could break
        // the memory limit, so it waits for a batch of its own.
        if (items > 0 && bytes + item.raw.byteLength > BATCH_LIMITS.bytes) {
          batch.outcome = "more";
          break;
        }
        prefix = importMessagePrefix(attemptPrefix, items);
        const result = await prepareImported(bucket, mail, {
          raw: item.raw,
          prefix,
          fallbackDate: item.fallbackDate,
        });
        prefix = null;
        items += 1;
        bytes += item.raw.byteLength;
        if (result.status === "ready") {
          batch.messages.push(result.message);
          r2Writes += result.r2Writes;
        } else if (result.status === "duplicate") {
          batch.duplicates += 1;
        } else {
          batch.unreadable.push({
            offset: item.start,
            size: item.raw.byteLength,
            reason: "tooLarge",
            hint: "",
          });
        }
        batch.position = item.next;
      }
      if (budgetSpent()) {
        batch.outcome = "more";
        break;
      }
    }
  } catch (error) {
    if (error instanceof FileMissing) {
      imports.failBatch(job.id, attempt, "fileMissing");
      return;
    }
    console.error("An import batch stopped early. It will try again.", error);
    batch.outcome = "storageError";
    if (prefix) batch.abandoned.push(prefix);
  }
  imports.saveBatch(job.id, attempt, batch);
}

async function abortUpload(
  imports: ImportStore,
  bucket: R2Bucket,
  job: JobRow,
): Promise<void> {
  try {
    await bucket.resumeMultipartUpload(job.r2_key, job.upload_id!).abort();
    imports.uploadAborted(job.id);
  } catch (error) {
    // The upload finishing or aborting first both leave nothing to abort.
    if (isUploadGone(error)) {
      imports.uploadAborted(job.id);
      return;
    }
    console.error("Could not abort an import's upload.", error);
    imports.retryAbort(job.id);
  }
}

export async function runDueImportWork(
  imports: ImportStore,
  mail: MailboxStore,
  bucket: R2Bucket,
  saveBatchStart: () => Promise<void>,
  now: number,
): Promise<void> {
  for (const job of imports.dueJobs(now)) {
    if (job.state === "queued" || job.state === "running") {
      await runBatch(imports, mail, bucket, saveBatchStart, job);
    } else if (job.state === "uploading") {
      imports.failUpload(job.id, "abandoned");
      await abortUpload(imports, bucket, job);
    } else if (job.upload_id !== null) {
      await abortUpload(imports, bucket, job);
    }
  }
}
