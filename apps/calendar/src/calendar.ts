import { DurableObject } from "cloudflare:workers";
import { applyMigrations, type SqlDriver } from "@cloudysuite/object-sql";
import { MIGRATIONS } from "./migrations";
import { type Actor, EventStore } from "./store";
import type {
  ChangeResult,
  ChangeScope,
  CreateResult,
  DayRange,
  EraseResult,
  EventDraft,
  EventTarget,
  RangeListing,
} from "./types";

// One calendar's events. Every call that reads or changes them is told who is asking,
// and refuses Can view a change, or anyone but a manager emptying it, in the same call
// that would make it.
export class Calendar extends DurableObject<Env> {
  readonly #store: EventStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db: SqlDriver = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (body) => ctx.storage.transactionSync(body),
    };
    applyMigrations(db, MIGRATIONS);
    this.#store = new EventStore(db);
  }

  listRange(actor: Actor, range: DayRange): RangeListing {
    return this.#store.listRange(actor, range);
  }

  createEvent(actor: Actor, draft: EventDraft): CreateResult {
    return this.#store.create(actor, draft, Date.now());
  }

  updateEvent(
    actor: Actor,
    target: EventTarget,
    scope: ChangeScope,
    draft: EventDraft,
  ): ChangeResult {
    return this.#store.update(actor, target, scope, draft, Date.now());
  }

  removeEvent(
    actor: Actor,
    target: EventTarget,
    scope: ChangeScope,
  ): ChangeResult {
    return this.#store.remove(actor, target, scope, Date.now());
  }

  erase(actor: Actor): EraseResult {
    return this.#store.erase(actor);
  }
}
