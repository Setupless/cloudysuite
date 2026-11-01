import type { MailboxId } from "@cloudysuite/access";
import {
  importAttemptPrefix,
  importFileKey,
  importFilePrefix,
} from "../r2-keys";
import type { SqlDriver, SqlRow } from "../sql";
import type { MailboxStore } from "../store";
import type { NewMessage } from "../types";
import type { MboxPosition } from "./mbox";
import {
  expectedPartBytes,
  IMPORT_TRANSITIONS,
  type ImportFailure,
  type ImportJobView,
  type ImportState,
  isActive,
  type NewImportFile,
  partCountFor,
  type UnreadableItem,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_EXPIRY_MS = 3 * DAY_MS;
export const NEXT_BATCH_DELAY_MS = 50;
// How soon to try again if a batch dies with no chance to reschedule itself.
export const CRASH_RETRY_MS = 15 * 1000;
const MAX_FAILURE_DELAY_MS = 15 * 60 * 1000;
const BASE_FAILURE_DELAY_MS = 5 * 1000;
// About 5 hours of retries, which outlasts a storage outage.
const MAX_FAILURES = 24;
const ABORT_RETRY_MS = 5 * 60 * 1000;
// Each item is a message over 25 MB, so a 100 GB file holds about 4,000 at most.
// That is safe to store, and more than is useful to show.
const UNREADABLE_SHOWN = 1000;

export type JobRow = SqlRow & {
  id: string;
  mailbox_id: MailboxId;
  state: ImportState;
  file_name: string;
  size: number;
  fingerprint: string;
  r2_key: string;
  upload_id: string | null;
  byte_offset: number;
  skipping: string | null;
  stored_count: number;
  duplicate_count: number;
  unreadable_count: number;
  attempt: string | null;
  crashes: number;
  failures: number;
  next_run_at: number | null;
  failure: ImportFailure | null;
  created_at: number;
  finished_at: number | null;
};

export type BatchPlan = {
  attempt: string;
  crashes: number;
  position: MboxPosition;
};

export type FinishedBatch = {
  messages: NewMessage[];
  duplicates: number;
  unreadable: UnreadableItem[];
  position: MboxPosition;
  // Prefixes of messages whose R2 writes failed partway.
  abandoned: string[];
  outcome: "more" | "endOfFile" | "storageError";
};

export type PartPlan =
  | {
      status: "ok";
      key: string;
      uploadId: string;
      expectedBytes: number;
    }
  | { status: "unknownJob" }
  | { status: "notUploading" }
  | { status: "badPartNumber" };

export type NewImportJob = NewImportFile & {
  id: string;
  mailboxId: MailboxId;
  uploadId: string;
};

// The import job's tables and every state change. A change of state happens only
// through #move, so an illegal transition throws instead of corrupting a job.
export class ImportStore {
  readonly #db: SqlDriver;
  readonly #mail: MailboxStore;

  constructor(db: SqlDriver, mail: MailboxStore) {
    this.#db = db;
    this.#mail = mail;
  }

  #row(jobId: string): JobRow | null {
    const [row] = this.#db
      .exec<JobRow>("SELECT * FROM import_jobs WHERE id = ?", jobId)
      .toArray();
    return row ?? null;
  }

  #active(): JobRow | null {
    const [row] = this.#db
      .exec<JobRow>(
        "SELECT * FROM import_jobs WHERE state IN ('uploading', 'queued', 'running') LIMIT 1",
      )
      .toArray();
    return row ?? null;
  }

  #view(row: JobRow): ImportJobView {
    return {
      id: row.id,
      state: row.state,
      fileName: row.file_name,
      size: row.size,
      fingerprint: row.fingerprint,
      partCount: partCountFor(row.size),
      uploadedParts:
        row.state === "uploading"
          ? this.parts(row.id).map((part) => part.partNumber)
          : [],
      byteOffset: row.byte_offset,
      stored: row.stored_count,
      duplicates: row.duplicate_count,
      unreadable: row.unreadable_count,
      failure: row.failure,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
    };
  }

  #move(
    row: JobRow,
    next: ImportState,
    changes: { nextRunAt: number | null; failure?: ImportFailure },
  ): void {
    if (!IMPORT_TRANSITIONS[row.state].includes(next)) {
      throw new Error(`An import cannot go from ${row.state} to ${next}.`);
    }
    this.#db.exec(
      `UPDATE import_jobs
       SET state = ?, next_run_at = ?, failure = COALESCE(?, failure),
           finished_at = CASE WHEN ? THEN ? ELSE finished_at END
       WHERE id = ?`,
      next,
      changes.nextRunAt,
      changes.failure ?? null,
      isActive(next) ? 0 : 1,
      Date.now(),
      row.id,
    );
  }

  // Everything a job leaves behind becomes queued work here, in the transaction
  // that ends it, so a crash cannot lose the clean-up.
  #end(row: JobRow, state: ImportState, failure?: ImportFailure): void {
    const now = Date.now();
    this.#move(row, state, {
      nextRunAt: row.upload_id === null ? null : now,
      ...(failure ? { failure } : {}),
    });
    this.#db.exec("DELETE FROM import_parts WHERE job_id = ?", row.id);
    // During an upload, a completion in flight could still create the file.
    this.#mail.queueDeletion(
      importFilePrefix(row.mailbox_id, row.id),
      row.state === "uploading" ? undefined : 0,
    );
    if (row.attempt !== null) {
      this.#mail.queueDeletion(
        importAttemptPrefix(row.mailbox_id, row.attempt),
      );
      this.#db.exec(
        "UPDATE import_jobs SET attempt = NULL WHERE id = ?",
        row.id,
      );
    }
  }

  jobs(limit: number): ImportJobView[] {
    return this.#db
      .exec<JobRow>(
        "SELECT * FROM import_jobs ORDER BY created_at DESC, id LIMIT ?",
        limit,
      )
      .toArray()
      .map((row) => this.#view(row));
  }

  job(jobId: string): ImportJobView | null {
    const row = this.#row(jobId);
    return row ? this.#view(row) : null;
  }

  hasActiveJob(): boolean {
    return this.#active() !== null;
  }

  // One job at a time, which also bounds what one mailbox can hold in R2.
  create(
    job: NewImportJob,
  ):
    | { status: "created"; job: ImportJobView }
    | { status: "busy"; job: ImportJobView } {
    return this.#db.transaction(() => {
      const active = this.#active();
      if (active) return { status: "busy", job: this.#view(active) };
      const now = Date.now();
      this.#db.exec(
        `INSERT INTO import_jobs
           (id, mailbox_id, state, file_name, size, fingerprint, r2_key, upload_id, next_run_at, created_at)
         VALUES (?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?)`,
        job.id,
        job.mailboxId,
        job.fileName,
        job.size,
        job.fingerprint,
        importFileKey(job.mailboxId, job.id),
        job.uploadId,
        now + UPLOAD_EXPIRY_MS,
        now,
      );
      return { status: "created", job: this.#view(this.#row(job.id)!) };
    });
  }

  partPlan(jobId: string, partNumber: number): PartPlan {
    const row = this.#row(jobId);
    if (!row) return { status: "unknownJob" };
    if (row.state !== "uploading" || row.upload_id === null) {
      return { status: "notUploading" };
    }
    const partCount = partCountFor(row.size);
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > partCount
    ) {
      return { status: "badPartNumber" };
    }
    return {
      status: "ok",
      key: row.r2_key,
      uploadId: row.upload_id,
      expectedBytes: expectedPartBytes(row.size, partNumber),
    };
  }

  // Sending a part again replaces it, in R2 and here, so a retry changes nothing.
  recordPart(jobId: string, partNumber: number, etag: string): void {
    this.#db.transaction(() => {
      if (this.#row(jobId)?.state !== "uploading") return;
      this.#db.exec(
        `INSERT INTO import_parts (job_id, part_number, etag) VALUES (?, ?, ?)
         ON CONFLICT (job_id, part_number) DO UPDATE SET etag = excluded.etag`,
        jobId,
        partNumber,
        etag,
      );
      this.#db.exec(
        "UPDATE import_jobs SET next_run_at = ? WHERE id = ?",
        Date.now() + UPLOAD_EXPIRY_MS,
        jobId,
      );
    });
  }

  parts(jobId: string): { partNumber: number; etag: string }[] {
    return this.#db
      .exec<{ part_number: number; etag: string }>(
        "SELECT part_number, etag FROM import_parts WHERE job_id = ? ORDER BY part_number",
        jobId,
      )
      .toArray()
      .map((row) => ({ partNumber: row.part_number, etag: row.etag }));
  }

  uploadTarget(jobId: string): {
    state: ImportState;
    key: string;
    uploadId: string | null;
    size: number;
  } | null {
    const row = this.#row(jobId);
    return row
      ? {
          state: row.state,
          key: row.r2_key,
          uploadId: row.upload_id,
          size: row.size,
        }
      : null;
  }

  // Repeatable. A job that was cancelled while R2 finished its file queues that
  // file for removal again, because the sweep may already have run.
  markUploaded(jobId: string): void {
    this.#db.transaction(() => {
      const row = this.#row(jobId);
      if (!row) return;
      if (row.state !== "uploading") {
        if (!isActive(row.state)) {
          this.#mail.queueDeletion(importFilePrefix(row.mailbox_id, row.id));
        }
        return;
      }
      this.#move(row, "queued", { nextRunAt: Date.now() });
      this.#db.exec(
        "UPDATE import_jobs SET upload_id = NULL WHERE id = ?",
        jobId,
      );
      this.#db.exec("DELETE FROM import_parts WHERE job_id = ?", jobId);
    });
  }

  failUpload(jobId: string, failure: ImportFailure): void {
    this.#db.transaction(() => {
      const row = this.#row(jobId);
      if (row && isActive(row.state)) this.#end(row, "failed", failure);
    });
  }

  cancel(jobId: string): void {
    this.#db.transaction(() => {
      const row = this.#row(jobId);
      if (row && isActive(row.state)) this.#end(row, "cancelled");
    });
  }

  unreadable(jobId: string): UnreadableItem[] {
    return this.#db
      .exec<SqlRow & UnreadableItem & { byte_offset: number }>(
        `SELECT byte_offset, size, reason, hint FROM import_unreadable
         WHERE job_id = ? ORDER BY byte_offset LIMIT ?`,
        jobId,
        UNREADABLE_SHOWN,
      )
      .toArray()
      .map(({ byte_offset, size, reason, hint }) => ({
        offset: byte_offset,
        size,
        reason,
        hint,
      }));
  }

  dueJobs(now: number): JobRow[] {
    return this.#db
      .exec<JobRow>(
        "SELECT * FROM import_jobs WHERE next_run_at <= ? ORDER BY next_run_at",
        now,
      )
      .toArray();
  }

  nextRunAt(): number | null {
    const [row] = this.#db
      .exec<{ next: number | null }>(
        "SELECT MIN(next_run_at) AS next FROM import_jobs",
      )
      .toArray();
    return row?.next ?? null;
  }

  uploadAborted(jobId: string): void {
    this.#db.exec(
      "UPDATE import_jobs SET upload_id = NULL, next_run_at = NULL WHERE id = ?",
      jobId,
    );
  }

  // Gives up after about 2 hours, because R2 removes an unfinished upload itself
  // after 7 days, and a job that retried forever would keep the alarm alive for good.
  retryAbort(jobId: string): void {
    const failures = (this.#row(jobId)?.failures ?? 0) + 1;
    if (failures >= MAX_FAILURES) {
      this.uploadAborted(jobId);
      return;
    }
    this.#db.exec(
      "UPDATE import_jobs SET failures = ?, next_run_at = ? WHERE id = ?",
      failures,
      Date.now() + ABORT_RETRY_MS,
      jobId,
    );
  }

  // Called before a batch writes anything. A saved attempt here means the last
  // batch stopped without saving, so its objects are orphans and it counts as a
  // crash. The retry time goes in now, because a batch that dies cannot set one.
  beginBatch(jobId: string, attempt: string): BatchPlan | null {
    return this.#db.transaction(() => {
      const row = this.#row(jobId);
      if (!row || (row.state !== "queued" && row.state !== "running")) {
        return null;
      }
      const crashed = row.attempt !== null;
      if (crashed) {
        this.#mail.queueDeletion(
          importAttemptPrefix(row.mailbox_id, row.attempt!),
        );
      }
      const now = Date.now();
      if (row.state === "queued") {
        this.#move(row, "running", { nextRunAt: now + CRASH_RETRY_MS });
      }
      const crashes = row.crashes + (crashed ? 1 : 0);
      this.#db.exec(
        "UPDATE import_jobs SET attempt = ?, crashes = ?, next_run_at = ? WHERE id = ?",
        attempt,
        crashes,
        now + CRASH_RETRY_MS,
        jobId,
      );
      return {
        attempt,
        crashes,
        position: {
          offset: row.byte_offset,
          skipping: row.skipping
            ? (JSON.parse(row.skipping) as MboxPosition["skipping"])
            : null,
        },
      };
    });
  }

  // The messages and the new offset share this one transaction, which is the
  // whole of the crash guarantee: either both are saved or the batch runs again.
  saveBatch(
    jobId: string,
    attempt: string,
    batch: FinishedBatch,
  ): "saved" | "stale" {
    return this.#db.transaction(() => {
      const row = this.#row(jobId);
      if (row?.state !== "running" || row.attempt !== attempt) {
        // Cancelled while this batch ran. Its writes may have landed after the
        // cancel queued them, and the rows they belong to will never exist.
        if (row) {
          this.#mail.queueDeletion(
            importAttemptPrefix(row.mailbox_id, attempt),
          );
        }
        return "stale";
      }

      let stored = 0;
      let duplicates = batch.duplicates;
      for (const message of batch.messages) {
        if (this.#mail.commit(message).status === "stored") stored += 1;
        else duplicates += 1;
      }
      for (const prefix of batch.abandoned) this.#mail.queueDeletion(prefix);

      for (const item of batch.unreadable) {
        this.#db.exec(
          `INSERT OR IGNORE INTO import_unreadable (job_id, byte_offset, size, reason, hint)
           VALUES (?, ?, ?, ?, ?)`,
          jobId,
          item.offset,
          item.size,
          item.reason,
          item.hint,
        );
      }

      const advanced = batch.position.offset !== row.byte_offset;
      const failures =
        batch.outcome === "storageError" && !advanced ? row.failures + 1 : 0;
      this.#db.exec(
        `UPDATE import_jobs
         SET byte_offset = ?, skipping = ?, stored_count = stored_count + ?,
             duplicate_count = duplicate_count + ?,
             unreadable_count = unreadable_count + ?, attempt = NULL,
             crashes = ?, failures = ?, next_run_at = ?
         WHERE id = ?`,
        batch.position.offset,
        batch.position.skipping
          ? JSON.stringify(batch.position.skipping)
          : null,
        stored,
        duplicates,
        batch.unreadable.length,
        advanced ? 0 : row.crashes,
        failures,
        Date.now() +
          (failures === 0
            ? NEXT_BATCH_DELAY_MS
            : Math.min(
                BASE_FAILURE_DELAY_MS * 2 ** (failures - 1),
                MAX_FAILURE_DELAY_MS,
              )),
        jobId,
      );

      const current = { ...row, attempt: null };
      if (batch.outcome === "endOfFile") this.#end(current, "done");
      else if (failures >= MAX_FAILURES) {
        this.#end(current, "failed", "storage");
      }
      return "saved";
    });
  }

  // For a file that cannot be read at all, where no batch has anything to save.
  failBatch(jobId: string, attempt: string, failure: ImportFailure): void {
    this.#db.transaction(() => {
      const row = this.#row(jobId);
      if (row?.state === "running" && row.attempt === attempt) {
        this.#end(row, "failed", failure);
      }
    });
  }
}
