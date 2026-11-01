import { DurableObject } from "cloudflare:workers";
import type { DriveId, UserId } from "@cloudysuite/access";
import { applyMigrations, type SqlDriver } from "@cloudysuite/object-sql";
import { isUploadGone } from "@cloudysuite/transfer";
import { moveReceiver } from "./client";
import { MIGRATIONS } from "./migrations";
import { type MoveDelivery, movedBytes, type ReceiveResult } from "./moves";
import type { ParsedName } from "./names";
import {
  type CommitResult,
  type CompletionPlan,
  DriveStore,
  type FoundUpload,
  type NewUpload,
  type NewUploadResult,
  type PartPlan,
  USAGE_RETRY_MS,
} from "./store";
import type {
  DriveItem,
  FileItem,
  FolderListing,
  ItemId,
  MoveResult,
  NewFolderResult,
  RenameResult,
  RestoreResult,
  TrashEntry,
  TrashResult,
  UploadView,
} from "./types";
import {
  claimDriveSpace,
  claimMoveSpace,
  type NextUsage,
  writeDriveUsage,
} from "./usage";

const SWEEP_LIMIT = 50;
const SWEEP_RETRY_MS = 60 * 60 * 1000;
const PURGE_BATCH = 100;
// Enough for an ordinary folder to be gone by the time the person's request returns.
// Anything bigger carries on from the alarm.
const PURGE_BATCHES_NOW = 5;
const MOVE_RETRY_MS = 60_000;
// After this, a drive that still hasn't answered no longer holds the sender's rows locked.
const MOVE_GIVE_UP_MS = 60 * 60 * 1000;
const MOVES_PER_WAKE_UP = 5;

export class Drive extends DurableObject<Env> {
  readonly #store: DriveStore;
  // One write to D1 at a time and each reads the truth when it starts, so a slow early
  // write can't land after a later one and leave D1 behind, or wipe out a claim.
  #d1Writes: Promise<unknown> = Promise.resolve();
  // Stops the alarm sending a move the person's request is still waiting on, so one
  // can't be refused and cancelled while the other is accepted.
  readonly #sendingMoves = new Set<string>();

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

  async createUpload(upload: NewUpload): Promise<NewUploadResult> {
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

  // With no limit set, a D1 failure can't hold up a file. The flag retries the totals.
  async commitUpload(
    id: ItemId,
    driveId: DriveId,
    limited: boolean,
  ): Promise<CommitResult> {
    const result = await this.#oneAtATime(async (): Promise<CommitResult> => {
      const size = limited ? this.#store.uncommittedSize(id) : null;
      if (size !== null) {
        this.#store.flagUsageWrite(driveId, Date.now());
        await this.#scheduleNextWakeUp();
        if (this.#store.uploadFolderIsLocked(id)) {
          return { status: "folderBusy" };
        }
        if (!(await claimDriveSpace(this.env.DB, driveId, this.#next(size)))) {
          this.#store.closeRefusedUpload(id, Date.now());
          await this.#scheduleNextWakeUp();
          return { status: "overLimit" };
        }
      }
      return this.#store.commitUpload(id, driveId, Date.now());
    });
    if (result.status === "committed" || result.status === "folderBusy") {
      await this.#afterChange();
    }
    return result;
  }

  #next(addedBytes: number): NextUsage {
    return this.#store.moveInDoubt()
      ? { added: addedBytes }
      : { total: (this.#store.usage()?.usedBytes ?? 0) + addedBytes };
  }

  async rename(input: {
    driveId: DriveId;
    id: ItemId;
    name: Extract<ParsedName, { ok: true }>;
  }): Promise<RenameResult> {
    const result = this.#store.rename({ ...input, now: Date.now() });
    if (result.status === "renamed") await this.#afterChange();
    return result;
  }

  async moveWithin(input: {
    driveId: DriveId;
    id: ItemId;
    toParentId: ItemId | null;
  }): Promise<MoveResult> {
    const result = this.#store.moveWithin({ ...input, now: Date.now() });
    if (result.status === "moved") await this.#afterChange();
    return result;
  }

  async moveToDrive(input: {
    driveId: DriveId;
    id: ItemId;
    toDriveId: DriveId;
    toParentId: ItemId | null;
  }): Promise<MoveResult> {
    const moveId = crypto.randomUUID();
    const now = Date.now();
    const begun = this.#store.beginMoveOut({
      moveId,
      id: input.id,
      fromDriveId: input.driveId,
      toDriveId: input.toDriveId,
      toParentId: input.toParentId,
      tryAt: now + MOVE_RETRY_MS,
      giveUpAt: now + MOVE_GIVE_UP_MS,
    });
    if (begun.status !== "begun") return begun;
    await this.#scheduleNextWakeUp();
    return this.#runMove(moveId);
  }

  // One step of a move, whichever phase it has reached. See moves.ts.
  async #runMove(moveId: string): Promise<MoveResult> {
    const move = this.#store.outgoingMove(moveId);
    if (!move) return { status: "pending" };
    if (this.#sendingMoves.has(moveId)) {
      this.#store.postponeMove(moveId, Date.now() + MOVE_RETRY_MS);
      return { status: "pending" };
    }
    this.#sendingMoves.add(moveId);
    const receiver = moveReceiver(this.env, move.toDriveId);
    try {
      switch (move.phase) {
        case "sending": {
          const answer = await receiver.receive(move);
          if (answer.status !== "received") {
            this.#store.cancelMoveOut(moveId);
            await this.#afterChange();
            return answer;
          }
          this.#store.handOverMove({
            moveId,
            driveId: move.fromDriveId,
            now: Date.now(),
            tryAt: Date.now() + MOVE_RETRY_MS,
          });
          await this.#afterChange();
          await receiver.confirm(moveId);
          break;
        }
        case "confirming":
          await receiver.confirm(moveId);
          break;
        case "abandoning":
          await receiver.abandon(moveId);
          break;
      }
      this.#store.endMoveOut(moveId);
      await this.#scheduleNextWakeUp();
      return { status: "moved" };
    } catch (error) {
      console.error("Could not finish a move. Trying again.", error);
      const now = Date.now();
      if (move.phase === "sending" && now >= move.giveUpAt) {
        this.#store.giveUpMoveOut(moveId, now);
        await this.#afterChange();
      } else {
        this.#store.postponeMove(moveId, now + MOVE_RETRY_MS);
        await this.#scheduleNextWakeUp();
      }
      // The rows have already left if only the last step failed, and the alarm finishes it.
      return this.#store.outgoingMove(moveId)?.phase === "confirming"
        ? { status: "moved" }
        : { status: "pending" };
    } finally {
      this.#sendingMoves.delete(moveId);
    }
  }

  // Claiming in the same turn as adding the rows means nothing can be written to D1 in
  // between. A refusal after the claim is put right by each drive's next exact total.
  async receiveMove(move: MoveDelivery): Promise<ReceiveResult> {
    const driveId = move.toDriveId;
    const bytes = movedBytes(move.rows);
    let changed = false;
    const result = await this.#oneAtATime(async (): Promise<ReceiveResult> => {
      const answer = this.#store.receiveAnswer(move);
      if (answer) return answer;
      changed = true;
      if (bytes > 0) {
        this.#store.flagUsageWrite(driveId, Date.now());
        await this.#scheduleNextWakeUp();
        const claimed = await claimMoveSpace(
          this.env.DB,
          { fromDriveId: move.fromDriveId, toDriveId: driveId, bytes },
          this.#next(bytes),
        );
        if (!claimed) return { status: "overLimit", bytes };
      }
      return this.#store.receiveMove(move, Date.now());
    });
    if (changed) await this.#afterChange();
    return result;
  }

  confirmMoveIn(moveId: string): void {
    this.#store.confirmMoveIn(moveId, Date.now());
  }

  async abandonMoveIn(moveId: string, driveId: DriveId): Promise<void> {
    this.#store.abandonMoveIn(moveId, driveId, Date.now());
    await this.#afterChange();
  }

  async trash(input: { driveId: DriveId; id: ItemId }): Promise<TrashResult> {
    const result = this.#store.trash({ ...input, now: Date.now() });
    if (result.status === "trashed") await this.#afterChange();
    return result;
  }

  trashEntries(limit: number): TrashEntry[] {
    return this.#store.trashEntries(Date.now(), limit);
  }

  async restore(input: {
    driveId: DriveId;
    id: ItemId;
  }): Promise<RestoreResult> {
    const result = this.#store.restore({ ...input, now: Date.now() });
    if (result.status === "restored") await this.#afterChange();
    return result;
  }

  async deleteForever(id: ItemId): Promise<void> {
    this.#store.markForPurge(id);
    await this.#purgeNow();
  }

  async emptyTrash(): Promise<void> {
    this.#store.markAllForPurge(Date.now());
    await this.#purgeNow();
  }

  async #purgeNow(): Promise<void> {
    const now = Date.now();
    for (let batch = 0; batch < PURGE_BATCHES_NOW; batch += 1) {
      if (!this.#store.purgeBatch(now, PURGE_BATCH)) break;
    }
    await this.#afterChange();
  }

  async #afterChange(): Promise<void> {
    await this.#scheduleNextWakeUp();
    await this.#writeUsage();
    await this.#scheduleNextWakeUp();
  }

  #oneAtATime<Result>(job: () => Promise<Result>): Promise<Result> {
    const run = this.#d1Writes.then(job);
    this.#d1Writes = run.catch(() => {});
    return run;
  }

  #writeUsage(): Promise<void> {
    return this.#oneAtATime(async () => {
      const usage = this.#store.usage();
      if (!usage) return;
      if (this.#store.moveInDoubt()) {
        this.#store.postponeUsageWrite(Date.now() + USAGE_RETRY_MS);
        return;
      }
      try {
        await writeDriveUsage(this.env.DB, usage);
        this.#store.markUsageWritten(usage);
      } catch (error) {
        console.error("Could not save a drive's totals. Trying again.", error);
        this.#store.postponeUsageWrite(Date.now() + USAGE_RETRY_MS);
      }
    });
  }

  // The alarm is always the earliest due time of the jobs below, each kept in its own
  // row. Call this before any other await, so it commits with the rows that need it.
  #scheduleNextWakeUp(): Promise<void> {
    const due = [
      this.#store.usageWriteDueAt(),
      this.#store.nextUploadExpiryAt(),
      this.#store.nextPurgeAt(),
      this.#store.nextR2DeletionAt(),
      this.#store.nextMoveAt(),
    ].filter((time) => time !== null);
    return due.length > 0
      ? // The runtime refuses a time of 0, which "due now" in the queues is stored as.
        this.ctx.storage.setAlarm(Math.max(Math.min(...due), 1))
      : this.ctx.storage.deleteAlarm();
  }

  override async alarm(): Promise<void> {
    await this.#retryMoves();
    const purged = this.#store.purgeBatch(Date.now(), PURGE_BATCH);
    await this.#sweepR2Deletions();
    const dueAt = this.#store.usageWriteDueAt();
    if (purged || (dueAt !== null && dueAt <= Date.now())) {
      await this.#writeUsage();
    }
    await this.#sweepUploads();
    await this.#scheduleNextWakeUp();
  }

  async #retryMoves(): Promise<void> {
    for (const moveId of this.#store.dueMoves(Date.now(), MOVES_PER_WAKE_UP)) {
      await this.#runMove(moveId);
    }
  }

  // A key leaves the queue only once R2 has said yes, and deleting a key R2 no longer
  // has succeeds, so a crash in between just deletes it again.
  async #sweepR2Deletions(): Promise<void> {
    const now = Date.now();
    const keys = this.#store.dueR2Deletions(now, SWEEP_LIMIT);
    if (keys.length === 0) return;
    try {
      await this.env.BUCKET.delete(keys);
      this.#store.finishR2Deletions(keys);
    } catch (error) {
      console.error("Could not remove deleted files. Trying later.", error);
      this.#store.postponeR2Deletions(keys, now + SWEEP_RETRY_MS);
    }
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
