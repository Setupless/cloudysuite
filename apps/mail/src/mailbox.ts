import { DurableObject } from "cloudflare:workers";
import type { MailboxId, UserId } from "@cloudysuite/access";
import { runDueSends } from "./compose/job";
import {
  type AddAttachmentResult,
  OutgoingStore,
  type ScheduleResult,
  type StoredSave,
} from "./compose/store";
import type {
  DiscardResult,
  OutgoingDetail,
  OutgoingId,
  OutgoingSummary,
  RemoveAttachmentResult,
} from "./compose/types";
import { runDueImportWork } from "./import/job";
import { ImportStore, type NewImportJob } from "./import/store";
import type { ImportFailure } from "./import/types";
import { LabelStore, type LabelWrite } from "./labels/store";
import { applyMigrations } from "@cloudysuite/object-sql";
import { MIGRATIONS } from "./migrations";
import type { JevPlan } from "./placement";
import { RuleStore } from "./rules/store";
import type { Rule, RuleDraft, RuleId, RuleWrite } from "./rules/types";
import { SpamStore } from "./spam/store";
import type { SenderEntry, SenderList, SenderWrite } from "./spam/types";
import { type SearchInput, type SearchPage, SearchStore } from "./search/store";
import { runDuePush } from "./push/job";
import { announces, PushStore } from "./push/store";
import type { SqlDriver } from "@cloudysuite/object-sql";
import { DELETION_SETTLE_MS, MailboxStore, sweepDeletions } from "./store";
import type {
  AttachmentId,
  AttachmentRef,
  RecentAttachment,
  Address,
  BodyRef,
  CommitResult,
  Folder,
  LabelColour,
  LabelId,
  MailboxSummary,
  MessageFlags,
  MessageId,
  MessageRef,
  MessageSelection,
  NewMessage,
  ThreadDetail,
  ThreadId,
  ThreadPage,
  ThreadQuery,
} from "./types";

export class Mailbox extends DurableObject<Env> {
  readonly #store: MailboxStore;
  readonly #imports: ImportStore;
  readonly #search: SearchStore;
  readonly #labels: LabelStore;
  readonly #rules: RuleStore;
  readonly #outgoing: OutgoingStore;
  readonly #spam: SpamStore;
  readonly #push: PushStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db: SqlDriver = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (body) => ctx.storage.transactionSync(body),
    };
    applyMigrations(db, MIGRATIONS);
    this.#store = new MailboxStore(db);
    this.#imports = new ImportStore(db, this.#store);
    this.#search = new SearchStore(db, this.#store);
    this.#rules = new RuleStore(db);
    this.#labels = new LabelStore(db, this.#rules);
    this.#outgoing = new OutgoingStore(db, this.#store);
    this.#spam = new SpamStore(db);
    this.#push = new PushStore(db);
  }

  findByHash(rawHash: string): MessageRef | null {
    return this.#store.findByHash(rawHash);
  }

  planJevCheck(message: NewMessage): JevPlan {
    return this.#store.planJevCheck(message);
  }

  // `inboundTo` is set only by the inbound path. A Durable Object cannot reliably read
  // its own name during an alarm, so the job needs to be told which mailbox this is.
  async commit(
    message: NewMessage,
    inboundTo: MailboxId | null = null,
  ): Promise<CommitResult> {
    const result = this.#store.commit(message);
    if (
      inboundTo !== null &&
      result.status === "stored" &&
      announces(result.folder)
    ) {
      this.#push.enqueue(result.messageId, inboundTo, Date.now());
    }
    await this.#scheduleNextWakeUp();
    return result;
  }

  pushMuted(userId: UserId): boolean {
    return this.#push.isMuted(userId);
  }

  setPushMuted(userId: UserId, muted: boolean): void {
    this.#push.setMuted(userId, muted);
  }

  async abandonUpload(prefix: string): Promise<void> {
    this.#store.queueDeletion(prefix);
    await this.#scheduleNextWakeUp();
  }

  listThreads(query: ThreadQuery): ThreadPage {
    return this.#store.listThreads(query);
  }

  search(input: SearchInput): SearchPage {
    return this.#search.search(input);
  }

  getThread(threadId: ThreadId): ThreadDetail | null {
    return this.#store.getThread(threadId);
  }

  setFlags(selection: MessageSelection, flags: MessageFlags): number {
    return this.#store.setFlags(selection, flags);
  }

  moveToFolder(selection: MessageSelection, folder: Folder): MessageRef[] {
    return this.#store.moveToFolder(selection, folder);
  }

  restore(selection: MessageSelection): MessageRef[] {
    return this.#store.restore(selection);
  }

  setLabel(
    selection: MessageSelection,
    labelId: LabelId,
    applied: boolean,
  ): boolean {
    return this.#store.setLabel(selection, labelId, applied);
  }

  createLabel(name: string, colour: LabelColour): LabelWrite {
    return this.#labels.create(name, colour);
  }

  updateLabel(
    id: LabelId,
    change: { name?: string | undefined; colour?: LabelColour | undefined },
  ): LabelWrite {
    return this.#labels.update(id, change);
  }

  deleteLabel(id: LabelId): void {
    this.#labels.delete(id);
  }

  listRules(): Rule[] {
    return this.#rules.list();
  }

  createRule(draft: RuleDraft): RuleWrite {
    return this.#rules.create(draft);
  }

  updateRule(id: RuleId, draft: RuleDraft): RuleWrite {
    return this.#rules.update(id, draft);
  }

  deleteRule(id: RuleId): void {
    this.#rules.delete(id);
  }

  reorderRules(ids: RuleId[]): boolean {
    return this.#rules.reorder(ids);
  }

  listSenders(): SenderEntry[] {
    return this.#spam.listSenders();
  }

  addSender(pattern: string, list: SenderList): SenderWrite {
    return this.#spam.addSender(pattern, list);
  }

  removeSender(pattern: string): void {
    this.#spam.removeSender(pattern);
  }

  threadOfMessage(messageId: MessageId): ThreadId | null {
    return this.#store.threadOfMessage(messageId);
  }

  summary(): MailboxSummary {
    return this.#store.summary();
  }

  inlineAttachmentRefs(messageId: MessageId): AttachmentRef[] {
    return this.#store.inlineAttachmentRefs(messageId);
  }

  bodyRefs(messageId: MessageId): BodyRef[] {
    return this.#store.bodyRefs(messageId);
  }

  attachmentRef(
    messageId: MessageId,
    attachmentId: AttachmentId,
  ): AttachmentRef | null {
    return this.#store.attachmentRef(messageId, attachmentId);
  }

  recentAttachments(limit: number): RecentAttachment[] {
    return this.#store.recentAttachments(limit);
  }

  listedAttachmentRef(
    messageId: MessageId,
    attachmentId: AttachmentId,
  ): AttachmentRef | null {
    return this.#store.listedAttachmentRef(messageId, attachmentId);
  }

  storagePrefix(messageId: MessageId): string | null {
    return this.#store.storagePrefix(messageId);
  }

  async deleteForever(selection: MessageSelection): Promise<number> {
    const deleted = this.#store.deleteForever(selection);
    await this.#scheduleNextWakeUp();
    await this.#sweep();
    await this.#scheduleNextWakeUp();
    return deleted;
  }

  hasActiveImport(): boolean {
    return this.#imports.hasActiveJob();
  }

  async createImportJob(job: NewImportJob) {
    const created = this.#imports.create(job);
    await this.#scheduleNextWakeUp();
    return created;
  }

  // A job's alarm is lost if the runtime gives up retrying it, so someone watching
  // the job is enough to start it again.
  async importJobs(limit: number) {
    if (
      this.#imports.nextRunAt() !== null &&
      (await this.ctx.storage.getAlarm()) === null
    ) {
      await this.#scheduleNextWakeUp();
    }
    return this.#imports.jobs(limit);
  }

  importJob(jobId: string) {
    return this.#imports.job(jobId);
  }

  importUnreadable(jobId: string) {
    return this.#imports.unreadable(jobId);
  }

  importPartPlan(jobId: string, partNumber: number) {
    return this.#imports.partPlan(jobId, partNumber);
  }

  async recordImportPart(jobId: string, partNumber: number, etag: string) {
    this.#imports.recordPart(jobId, partNumber, etag);
    await this.#scheduleNextWakeUp();
  }

  importParts(jobId: string) {
    return this.#imports.parts(jobId);
  }

  importUploadTarget(jobId: string) {
    return this.#imports.uploadTarget(jobId);
  }

  async markImportUploaded(jobId: string) {
    this.#imports.markUploaded(jobId);
    await this.#scheduleNextWakeUp();
  }

  async failImportUpload(jobId: string, failure: ImportFailure) {
    this.#imports.failUpload(jobId, failure);
    await this.#scheduleNextWakeUp();
  }

  async cancelImportJob(jobId: string) {
    this.#imports.cancel(jobId);
    await this.#scheduleNextWakeUp();
  }

  // A send's alarm is lost if the runtime gives up retrying it, so anyone with the
  // mailbox open starts it again, as with imports.
  async listOutgoing(viewerId: string): Promise<OutgoingSummary[]> {
    if (
      this.#outgoing.nextDueAt() !== null &&
      (await this.ctx.storage.getAlarm()) === null
    ) {
      await this.#scheduleNextWakeUp();
    }
    return this.#outgoing.list(viewerId);
  }

  outgoingDetail(id: OutgoingId, viewerId: string): OutgoingDetail | null {
    return this.#outgoing.detail(id, viewerId);
  }

  suggestAddresses(query: string): Address[] {
    return this.#outgoing.suggestions(query, 8);
  }

  async saveOutgoing(
    input: Parameters<OutgoingStore["save"]>[0],
  ): Promise<StoredSave> {
    const result = this.#outgoing.save(input);
    if (result.status === "removed") await this.#scheduleNextWakeUp();
    return result;
  }

  carryIntoOutgoingCopy(
    id: OutgoingId,
    carried: Parameters<OutgoingStore["carryIntoCopy"]>[1],
  ): ReturnType<OutgoingStore["carryIntoCopy"]> {
    return this.#outgoing.carryIntoCopy(id, carried);
  }

  async scheduleOutgoing(
    input: Parameters<OutgoingStore["schedule"]>[0],
  ): Promise<ScheduleResult> {
    const result = this.#outgoing.schedule(input);
    await this.#scheduleNextWakeUp();
    return result;
  }

  async undoOutgoing(id: OutgoingId): Promise<boolean> {
    const undone = this.#outgoing.undo(id);
    await this.#scheduleNextWakeUp();
    return undone;
  }

  reopenOutgoing(id: OutgoingId): boolean {
    return this.#outgoing.reopen(id);
  }

  async discardOutgoing(
    input: Parameters<OutgoingStore["discard"]>[0],
  ): Promise<DiscardResult> {
    const result = this.#outgoing.discard(input);
    await this.#scheduleNextWakeUp();
    return result;
  }

  addOutgoingAttachment(
    input: Parameters<OutgoingStore["addAttachment"]>[0],
  ): AddAttachmentResult {
    return this.#outgoing.addAttachment(input);
  }

  async removeOutgoingAttachment(
    input: Parameters<OutgoingStore["removeAttachment"]>[0],
  ): Promise<RemoveAttachmentResult> {
    const result = this.#outgoing.removeAttachment(input);
    await this.#scheduleNextWakeUp();
    return result;
  }

  // Every background job keeps its own due time in its own table, and this one
  // alarm is always the earliest of them. So a job that reschedules itself can
  // neither push another job back nor be pushed back by it. Call this before any
  // other await, so the alarm commits together with the rows that need it.
  #scheduleNextWakeUp(): Promise<void> {
    const due = [
      this.#store.nextDeletionAt(),
      this.#imports.nextRunAt(),
      this.#outgoing.nextDueAt(),
      this.#push.nextRunAt(),
    ].filter((time) => time !== null);
    return due.length > 0
      ? this.ctx.storage.setAlarm(Math.min(...due))
      : this.ctx.storage.deleteAlarm();
  }

  // Each job catches its own failure, so one that keeps failing still leaves the
  // others to run. A later job adds itself here and in #scheduleNextWakeUp.
  override async alarm(): Promise<void> {
    await this.#runSends();
    await this.#sweep();
    await this.#runImports();
    await this.#runPush();
    await this.#scheduleNextWakeUp();
  }

  // First, so a long import batch can't stretch a ten-second undo window. A throw here
  // leaves each job's state as saved, and its own due time brings it back.
  async #runSends(): Promise<void> {
    try {
      await runDueSends(
        this.#outgoing,
        this.env.BUCKET,
        this.env.EMAIL,
        this.env.DB,
        async () => {
          await this.#scheduleNextWakeUp();
          await this.ctx.storage.sync();
        },
        Date.now(),
      );
    } catch (error) {
      console.error("A send step stopped. It will be looked at again.", error);
    }
  }

  async #sweep(): Promise<void> {
    const now = Date.now();
    try {
      await sweepDeletions(this.#store, this.env.BUCKET, now);
    } catch (error) {
      console.error(
        "Could not finish removing deleted mail from storage.",
        error,
      );
      this.#store.postponeDeletions(now, now + DELETION_SETTLE_MS);
    }
  }

  // A throw here leaves the batch's attempt saved, so the next run counts it as a
  // crash, which is how a message that always breaks the commit gets skipped.
  async #runImports(): Promise<void> {
    try {
      await runDueImportWork(
        this.#imports,
        this.#store,
        this.env.BUCKET,
        async () => {
          await this.#scheduleNextWakeUp();
          await this.ctx.storage.sync();
        },
        Date.now(),
      );
    } catch (error) {
      console.error("An import batch stopped. It will try again.", error);
    }
  }

  async #runPush(): Promise<void> {
    try {
      await runDuePush(this.#push, {
        database: this.env.DB,
        fetch: (url, init) => fetch(url, init),
        now: Date.now,
      });
    } catch (error) {
      console.error(
        "Could not send notifications. They will try again.",
        error,
      );
      this.#push.postpone(Date.now());
    }
  }
}
