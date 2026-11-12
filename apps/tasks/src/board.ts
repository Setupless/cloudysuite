import { DurableObject } from "cloudflare:workers";
import { applyMigrations, type SqlDriver } from "@cloudysuite/object-sql";
import { MIGRATIONS } from "./migrations";
import { type Actor, TaskStore } from "./store";
import type { ChangeResult, Task, TaskChange, TaskId } from "./types";

// One board's tasks and their checklists. Every call is told who is asking, and the
// store refuses what they may not do in the same call that would do it.
export class Board extends DurableObject<Env> {
  readonly #store: TaskStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db: SqlDriver = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (body) => ctx.storage.transactionSync(body),
    };
    applyMigrations(db, MIGRATIONS);
    this.#store = new TaskStore(db);
  }

  listTasks(actor: Actor): Task[] {
    return this.#store.list(actor);
  }

  findTask(actor: Actor, id: TaskId): Task | null {
    return this.#store.find(actor, id);
  }

  async changeTask(actor: Actor, change: TaskChange): Promise<ChangeResult> {
    const result = this.#store.change(actor, change, Date.now());
    await this.#scheduleNextWakeUp();
    return result;
  }

  // Call this before any other await, so it commits with the rows that need it.
  #scheduleNextWakeUp(): Promise<void> {
    const due = this.#store.nextWakeUpAt();
    return due === null
      ? this.ctx.storage.deleteAlarm()
      : this.ctx.storage.setAlarm(due);
  }

  override async alarm(): Promise<void> {
    this.#store.purgeDeleted(Date.now());
    await this.#scheduleNextWakeUp();
  }
}
