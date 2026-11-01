import { DurableObject } from "cloudflare:workers";
import { applyMigrations } from "./migrations";
import type { SqlDriver } from "./sql";
import { MailboxStore, sweepDeletions } from "./store";
import type {
  AttachmentId,
  AttachmentRef,
  BodyRef,
  CommitResult,
  Folder,
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

const SWEEP_RETRY_MS = 5 * 60 * 1000;

export class Mailbox extends DurableObject<Env> {
  readonly #store: MailboxStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db: SqlDriver = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (body) => ctx.storage.transactionSync(body),
    };
    applyMigrations(db);
    this.#store = new MailboxStore(db);
  }

  findByHash(rawHash: string): MessageRef | null {
    return this.#store.findByHash(rawHash);
  }

  commit(message: NewMessage): CommitResult {
    return this.#store.commit(message);
  }

  listThreads(query: ThreadQuery): ThreadPage {
    return this.#store.listThreads(query);
  }

  getThread(threadId: ThreadId): ThreadDetail | null {
    return this.#store.getThread(threadId);
  }

  setFlags(selection: MessageSelection, flags: MessageFlags): number {
    return this.#store.setFlags(selection, flags);
  }

  moveToFolder(selection: MessageSelection, folder: Folder): number {
    return this.#store.moveToFolder(selection, folder);
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
    // Set before any await, so the alarm commits together with the queued rows
    // and a crash during the sweep still finishes the job.
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_RETRY_MS);
    await this.#sweep();
    return deleted;
  }

  // One alarm serves every background job in a mailbox. A later job must add its
  // work here and keep the earliest wake-up, not replace the alarm.
  override async alarm(): Promise<void> {
    await this.#sweep();
  }

  async #sweep(): Promise<void> {
    let pending = true;
    try {
      pending = await sweepDeletions(this.#store, this.env.BUCKET);
    } catch (error) {
      console.error(
        "Could not finish removing deleted mail from storage.",
        error,
      );
    }
    if (pending) await this.ctx.storage.setAlarm(Date.now() + SWEEP_RETRY_MS);
    else await this.ctx.storage.deleteAlarm();
  }
}
