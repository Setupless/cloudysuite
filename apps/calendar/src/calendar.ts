import { DurableObject } from "cloudflare:workers";
import { applyMigrations, type SqlDriver } from "@cloudysuite/object-sql";
import type { SearchTerm } from "@cloudysuite/search";
import { findEvents } from "./event-search";
import { MIGRATIONS } from "./migrations";
import {
  type Actor,
  EventStore,
  type ImportGroup,
  type ImportResult,
} from "./store";
import type {
  ChangeResult,
  ChangeScope,
  CreateResult,
  DayRange,
  EraseResult,
  EventDraft,
  EventSearchResult,
  EventTarget,
  RangeListing,
  TimeZone,
} from "./types";

// One calendar's events. Every call that reads or changes them is told who is asking,
// and refuses Can view a change, or anyone but a manager emptying it, in the same call
// that would make it.
export class Calendar extends DurableObject<Env> {
  readonly #db: SqlDriver;
  readonly #store: EventStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db: SqlDriver = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings),
      transaction: (body) => ctx.storage.transactionSync(body),
    };
    applyMigrations(db, MIGRATIONS);
    this.#db = db;
    this.#store = new EventStore(db);
  }

  listRange(actor: Actor, range: DayRange): RangeListing {
    return this.#store.listRange(actor, range);
  }

  searchEvents(
    actor: Actor,
    terms: SearchTerm[],
    timeZone: TimeZone,
  ): EventSearchResult {
    return findEvents(this.#db, actor, terms, timeZone, Date.now());
  }

  createEvent(
    actor: Actor,
    organiserName: string,
    draft: EventDraft,
  ): CreateResult {
    return this.#store.create(actor, organiserName, draft, Date.now());
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

  importEvents(
    actor: Actor,
    organiserName: string,
    groups: ImportGroup[],
  ): ImportResult {
    return this.#store.importEvents(actor, organiserName, groups, Date.now());
  }

  // Anyone on the calendar sees its events, so anyone on it may know how many there are.
  countEvents(_actor: Actor): number {
    return this.#store.countEvents();
  }

  erase(actor: Actor): EraseResult {
    return this.#store.erase(actor);
  }
}
