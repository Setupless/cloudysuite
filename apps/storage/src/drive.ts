import { DurableObject } from "cloudflare:workers";
import type { DriveId, UserId } from "@cloudysuite/access";
import { applyMigrations, type SqlDriver } from "@cloudysuite/object-sql";
import { isUploadGone } from "@cloudysuite/transfer";
import { MIGRATIONS } from "./migrations";
import type { ParsedName } from "./names";
import {
  type CommitResult,
  type CompletionPlan,
  DriveStore,
  type FoundUpload,
  type NewUpload,
  type PartPlan,
  USAGE_RETRY_MS,
} from "./store";
import type {
  DriveItem,
  FileItem,
  FolderListing,
  ItemId,
  NewFolderResult,
  UploadView,
} from "./types";
import { writeDriveUsage } from "./usage";

const SWEEP_LIMIT = 50;
const SWEEP_RETRY_MS = 60 * 60 * 1000;

export class Drive extends DurableObject<Env> {
  readonly #store: DriveStore;
  // One write at a time and each reads the truth when it starts, so a slow early
  // write can't land after a later one and leave D1 behind.
  #usageWrites: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db: SqlDriver = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (body) => ctx.storage.transactionSync(body),
    };
    applyMigrations(db, MIGRATIONS);
    this.#store = new DriveStore(db);
  }

  list(parentId: ItemId | null, cursor: string | null): FolderListing | null {
    return this.#store.list(parentId, cursor);
  }

  item(id: ItemId): DriveItem | null {
    return this.#store.item(id);
  }

  recent(limit: number): FileItem[] {
    return this.#store.recent(limit);
  }

  r2KeyOf(id: ItemId): string | null {
    return this.#store.r2KeyOf(id);
  }

  async createFolder(input: {
    driveId: DriveId;
    id: ItemId;
    parentId: ItemId | null;
    name: Extract<ParsedName, { ok: true }>;
    createdBy: UserId;
  }): Promise<NewFolderResult> {
    const result = this.#store.createFolder({ ...input, now: Date.now() });
    if (result.status === "created") await this.#afterChange();
    return result;
  }

  folderExists(id: ItemId): boolean {
    return this.#store.folderExists(id);
  }

  async findUpload(found: FoundUpload): Promise<UploadView | null> {
    const upload = this.#store.findUpload(found, Date.now());
    if (upload) await this.#scheduleNextWakeUp();
    return upload;
  }

  async createUpload(upload: NewUpload) {
    const created = this.#store.createUpload(upload, Date.now());
    await this.#scheduleNextWakeUp();
    return created;
  }

  partPlan(id: ItemId, partNumber: number): PartPlan {
    return this.#store.partPlan(id, partNumber);
  }

  async recordPart(id: ItemId, partNumber: number, etag: string) {
    this.#store.recordPart(id, partNumber, etag, Date.now());
    await this.#scheduleNextWakeUp();
  }

  // R2 no longer has this upload, so choosing the file again must start a new one.
  async forgetUpload(id: ItemId): Promise<void> {
    this.#store.removeUpload(id);
    await this.#scheduleNextWakeUp();
  }

  completionPlan(id: ItemId): CompletionPlan {
    return this.#store.completionPlan(id);
  }

  async commitUpload(id: ItemId, driveId: DriveId): Promise<CommitResult> {
    const result = this.#store.commitUpload(id, driveId, Date.now());
    if (result.status === "committed") await this.#afterChange();
    return result;
  }

  async #afterChange(): Promise<void> {
    await this.#scheduleNextWakeUp();
    await this.#writeUsage();
    await this.#scheduleNextWakeUp();
  }

  #writeUsage(): Promise<void> {
    this.#usageWrites = this.#usageWrites.then(async () => {
      const usage = this.#store.usage();
      if (!usage) return;
      try {
        await writeDriveUsage(this.env.DB, usage);
        this.#store.markUsageWritten(usage);
      } catch (error) {
        console.error("Could not save a drive's totals. Trying again.", error);
        this.#store.postponeUsageWrite(Date.now() + USAGE_RETRY_MS);
      }
    });
    return this.#usageWrites;
  }

  // The alarm is always the earliest due time of the jobs below, each kept in its own
  // row. Call this before any other await, so it commits with the rows that need it.
  #scheduleNextWakeUp(): Promise<void> {
    const due = [
      this.#store.usageWriteDueAt(),
      this.#store.nextUploadExpiryAt(),
    ].filter((time) => time !== null);
    return due.length > 0
      ? this.ctx.storage.setAlarm(Math.min(...due))
      : this.ctx.storage.deleteAlarm();
  }

  override async alarm(): Promise<void> {
    const dueAt = this.#store.usageWriteDueAt();
    if (dueAt !== null && dueAt <= Date.now()) await this.#writeUsage();
    await this.#sweepUploads();
    await this.#scheduleNextWakeUp();
  }

  // A finished item has no upload row and a closed upload can't become one, so this
  // can't touch a kept file. Deleting the key clears the object left by a crash between
  // R2 finishing and the commit.
  async #sweepUploads(): Promise<void> {
    const now = Date.now();
    for (const stale of this.#store.closeStaleUploads(now, SWEEP_LIMIT)) {
      try {
        await this.env.BUCKET.resumeMultipartUpload(
          stale.r2Key,
          stale.r2UploadId,
        )
          .abort()
          .catch((error: unknown) => {
            if (!isUploadGone(error)) throw error;
          });
        await this.env.BUCKET.delete([stale.r2Key]);
        this.#store.removeUpload(stale.id);
      } catch (error) {
        console.error(
          "Could not remove a stopped upload. Trying later.",
          error,
        );
        this.#store.postponeUpload(stale.id, now + SWEEP_RETRY_MS);
      }
    }
  }
}
