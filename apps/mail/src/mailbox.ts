import { DurableObject } from "cloudflare:workers";
import type { MailboxId } from "@cloudysuite/access";
import { runDueSends } from "./compose/job";
import {
  type AddAttachmentResult,
  type NewOutgoing,
  OutgoingStore,
  type ScheduleResult,
} from "./compose/store";
import type {
  DraftContent,
  Editor,
  OutgoingDetail,
  OutgoingId,
  OutgoingSummary,
  SaveResult,
} from "./compose/types";
import { runDueImportWork } from "./import/job";
import { ImportStore, type NewImportJob } from "./import/store";
import type { ImportFailure } from "./import/types";
import { LabelStore, type LabelWrite } from "./labels/store";
import { applyMigrations } from "./migrations";
import { RuleStore } from "./rules/store";
import type { Rule, RuleDraft, RuleId, RuleWrite } from "./rules/types";
import { SpamStore } from "./spam/store";
import type { SenderEntry, SenderList, SenderWrite } from "./spam/types";
import { type SearchInput, type SearchPage, SearchStore } from "./search/store";
import type { SqlDriver } from "./sql";
import { DELETION_SETTLE_MS, MailboxStore, sweepDeletions } from "./store";
import type {
  AttachmentId,
  AttachmentRef,
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db: SqlDriver = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (body) => ctx.storage.transactionSync(body),
    };
    applyMigrations(db);
    this.#store = new MailboxStore(db);
    this.#imports = new ImportStore(db, this.#store);
    this.#search = new SearchStore(db, this.#store);
    this.#rules = new RuleStore(db);
    this.#labels = new LabelStore(db, this.#rules);
    this.#outgoing = new OutgoingStore(db, this.#store);
    this.#spam = new SpamStore(db);
  }

  findByHash(rawHash: string): MessageRef | null {
    return this.#store.findByHash(rawHash);
  }

  async commit(message: NewMessage): Promise<CommitResult> {
    const result = this.#store.commit(message);
    if (result.status === "duplicate") await this.#scheduleNextWakeUp();
    return result;
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

  createOutgoing(input: NewOutgoing): void {
    this.#outgoing.create(input);
  }

  saveOutgoing(input: {
    id: OutgoingId;
    baseRevision: number;
    content: DraftContent;
    plainText: string;
    editor: Editor;
    r2Prefix: string;
  }): SaveResult {
    return this.#outgoing.save(input);
  }

  async scheduleOutgoing(input: {
    id: OutgoingId;
    content: DraftContent;
    plainText: string;
    editor: Editor;
    r2Prefix: string;
    fromName: string;
    mailboxId: MailboxId;
  }): Promise<ScheduleResult> {
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
    id: OutgoingId,
    onlyAtRevision?: number,
  ): Promise<boolean> {
    const discarded = this.#outgoing.discard(id, onlyAtRevision);
    await this.#scheduleNextWakeUp();
    return discarded;
  }

  addOutgoingAttachment(
    input: Parameters<OutgoingStore["addAttachment"]>[0],
  ): AddAttachmentResult {
    return this.#outgoing.addAttachment(input);
  }

  async removeOutgoingAttachment(
    id: OutgoingId,
    attachmentId: number,
  ): Promise<boolean> {
    const removed = this.#outgoing.removeAttachment(id, attachmentId);
    await this.#scheduleNextWakeUp();
    return removed;
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
}
