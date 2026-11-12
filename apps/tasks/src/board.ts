import { DurableObject } from "cloudflare:workers";
import { applyMigrations, type SqlDriver } from "@cloudysuite/object-sql";
import type { BoardId, UserId } from "@cloudysuite/access";
import type { SearchTerm } from "@cloudysuite/search";
import { moveReceiver } from "./client";
import { runDueEmails } from "./email/send";
import { MIGRATIONS } from "./migrations";
import type { MoveDelivery, ReceiveAnswer } from "./moves";
import { type Actor, TaskStore } from "./store";
import type {
  AssignmentEmailStatus,
  ChangeResult,
  MoveDestination,
  MoveOutcome,
  Task,
  TaskChange,
  TaskId,
} from "./types";

const MOVE_RETRY_MS = 60_000;
// After this, a board that still hasn't answered no longer holds the task locked here.
const MOVE_GIVE_UP_MS = 60 * 60 * 1000;
const MOVES_PER_WAKE_UP = 5;

// One board's tasks and their checklists. Every call is told who is asking, and the
// store refuses what they may not do in the same call that would do it.
export class Board extends DurableObject<Env> {
  readonly #store: TaskStore;
  // Stops the alarm sending a move the person's request is still waiting on, so one
  // can't be refused while the other is accepted.
  readonly #sendingMoves = new Set<string>();

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

  listMyTasks(actor: Actor, doneSince: number): Task[] {
    return this.#store.listMine(actor, doneSince);
  }

  listOpenFor(actor: Actor, assigneeId: UserId): Task[] {
    return this.#store.listOpenFor(actor, assigneeId);
  }

  searchTasks(
    actor: Actor,
    terms: SearchTerm[],
  ): { tasks: Task[]; more: boolean } {
    return this.#store.search(actor, terms);
  }

  findTask(actor: Actor, id: TaskId): Task | null {
    return this.#store.find(actor, id);
  }

  countTasks(actor: Actor): number {
    return this.#store.count(actor);
  }

  async erase(actor: Actor): Promise<"done" | "noAccess"> {
    const result = this.#store.erase(actor);
    await this.#scheduleNextWakeUp();
    return result;
  }

  async changeTask(actor: Actor, change: TaskChange): Promise<ChangeResult> {
    const result = this.#store.change(actor, change, Date.now());
    await this.#scheduleNextWakeUp();
    return result;
  }

  async moveTask(
    actor: Actor,
    input: {
      id: TaskId;
      toBoardId: BoardId;
      to: MoveDestination;
      keepAssigneeId: UserId | null;
    },
  ): Promise<MoveOutcome> {
    const moveId = crypto.randomUUID();
    const now = Date.now();
    const begun = this.#store.beginMoveOut(actor, {
      ...input,
      moveId,
      tryAt: now + MOVE_RETRY_MS,
      giveUpAt: now + MOVE_GIVE_UP_MS,
    });
    if (begun.status !== "begun") return begun;
    await this.#scheduleNextWakeUp();
    return this.#runMove(moveId);
  }

  // One step of a move out, whichever phase it has reached. See moves.ts.
  async #runMove(moveId: string): Promise<MoveOutcome> {
    const move = this.#store.outgoingMove(moveId);
    if (!move) return { status: "pending" };
    const retryAt = () => Date.now() + MOVE_RETRY_MS;
    if (this.#sendingMoves.has(moveId)) {
      this.#store.postponeMove(moveId, retryAt());
      return { status: "pending" };
    }
    this.#sendingMoves.add(moveId);
    const receiver = moveReceiver(this.env, move.toBoardId);
    try {
      switch (move.phase) {
        case "locked": {
          const answer = await receiver.add(move.movedBy, {
            moveId,
            task: move.task,
          });
          if (answer.status === "refused") {
            this.#store.advanceOut(moveId, "refused", retryAt());
            await this.#scheduleNextWakeUp();
            return { status: "refusedThere", reason: answer.reason };
          }
          this.#store.advanceOut(moveId, "added", retryAt());
          await this.#scheduleNextWakeUp();
          await receiver.unlock(moveId);
          break;
        }
        case "added":
          await receiver.unlock(moveId);
          break;
        case "givenUp":
          await receiver.drop(moveId);
          break;
      }
      this.#store.advanceOut(
        moveId,
        move.phase === "givenUp" ? "dropped" : "unlocked",
        retryAt(),
      );
      await this.#scheduleNextWakeUp();
      return { status: "moved" };
    } catch (error) {
      console.error("Could not finish moving a task. Trying again.", error);
      if (move.phase === "locked" && Date.now() >= move.giveUpAt) {
        this.#store.advanceOut(moveId, "noAnswer", retryAt());
      } else {
        this.#store.postponeMove(moveId, retryAt());
      }
      await this.#scheduleNextWakeUp();
      // The task has already left if only the unlock failed, and the alarm finishes it.
      return this.#store.outgoingMove(moveId)?.phase === "added"
        ? { status: "moved" }
        : { status: "pending" };
    } finally {
      this.#sendingMoves.delete(moveId);
    }
  }

  assignmentEmail(actor: Actor, id: TaskId): AssignmentEmailStatus {
    return this.#store.emailStatus(actor, id);
  }

  async retryAssignmentEmail(
    actor: Actor,
    id: TaskId,
  ): Promise<"done" | "noAccess"> {
    const result = this.#store.retryEmail(actor, id, Date.now());
    await this.#scheduleNextWakeUp();
    return result;
  }

  receiveMove(actor: Actor, delivery: MoveDelivery): ReceiveAnswer {
    return this.#store.receiveMove(actor, delivery);
  }

  unlockMoveIn(moveId: string): void {
    this.#store.unlockMoveIn(moveId);
  }

  dropMoveIn(moveId: string): void {
    this.#store.dropMoveIn(moveId);
  }

  // Call this before any other await, so it commits with the rows that need it.
  #scheduleNextWakeUp(): Promise<void> {
    const due = this.#store.nextWakeUpAt();
    return due === null
      ? this.ctx.storage.deleteAlarm()
      : this.ctx.storage.setAlarm(due);
  }

  // The purge goes first, so an email about a task deleted for good goes with it.
  override async alarm(): Promise<void> {
    this.#store.purgeDeleted(Date.now());
    await this.#sendEmails();
    for (const moveId of this.#store.dueMoves(Date.now(), MOVES_PER_WAKE_UP)) {
      await this.#runMove(moveId);
    }
    await this.#scheduleNextWakeUp();
  }

  async #sendEmails(): Promise<void> {
    try {
      await runDueEmails(
        {
          store: this.#store,
          database: this.env.DB,
          email: {
            send: async ({ from, to, raw }) => {
              // Loaded here, so code that never sends doesn't need the Workers runtime.
              const { EmailMessage } = await import("cloudflare:email");
              return this.env.EMAIL.send(new EmailMessage(from, to, raw));
            },
          },
          saveProgress: async () => {
            await this.#scheduleNextWakeUp();
            await this.ctx.storage.sync();
          },
        },
        Date.now(),
      );
    } catch (error) {
      console.error(
        "Assignment emails stopped. They'll be looked at again.",
        error,
      );
    }
  }
}
