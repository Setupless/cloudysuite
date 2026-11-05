import { DurableObject } from "cloudflare:workers";
import { applyMigrations, type SqlDriver } from "@cloudysuite/object-sql";
import type { SearchTerm } from "@cloudysuite/search";
import type { UserId } from "@cloudysuite/access";
import { isAppOff } from "../../../src/app-on";
import { invitationReceiver } from "./client";
import { findPersonalCalendar, makePersonalCalendar } from "./directory";
import { runDueEmails } from "./email/send";
import { outsideInviting } from "./email/senders";
import { findEvents } from "./event-search";
import { listInvitations } from "./invitation-list";
import {
  type AnswerNotice,
  copyUidOf,
  type Delivery,
  type DeliveryResult,
} from "./invitations";
import { MIGRATIONS } from "./migrations";
import {
  type Actor,
  EventStore,
  type ImportGroup,
  type ImportResult,
} from "./store";
import type {
  Answer,
  AnswerResult,
  ChangeResult,
  ChangeScope,
  CreateResult,
  DayRange,
  EraseResult,
  EventDraft,
  EventSearchResult,
  EventTarget,
  EventUid,
  Invitee,
  Occurrence,
  OutsideInviting,
  PersonKey,
  RangeListing,
  RetryResult,
  TimeZone,
} from "./types";

const DELIVERIES_PER_WAKE_UP = 25;
const ANSWERS_PER_WAKE_UP = 25;
const OFF_HOLDS = "offHolds";
const FIRST_OFF_HOLD_MS = 60_000;
const LONGEST_OFF_HOLD_MS = 15 * 60_000;

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

  invitations(actor: Actor, timeZone: TimeZone): Occurrence[] {
    return listInvitations(this.#db, actor, timeZone, Date.now());
  }

  // Only a draft that names an address needs to know. Anyone else's answer is never read.
  async #outsideFor(
    draft: EventDraft,
    organiser: UserId | null,
  ): Promise<OutsideInviting> {
    if (organiser === null) return "noSender";
    return draft.people.some((person) => typeof person !== "string")
      ? outsideInviting(this.env.DB, organiser)
      : "ready";
  }

  async createEvent(
    actor: Actor,
    organiserName: string,
    draft: EventDraft,
    invitable: Invitee[],
  ): Promise<CreateResult> {
    const outside = await this.#outsideFor(draft, actor.userId);
    const result = this.#store.create(
      actor,
      organiserName,
      draft,
      invitable,
      outside,
      Date.now(),
    );
    await this.#scheduleNextWakeUp();
    return result;
  }

  async updateEvent(
    actor: Actor,
    target: EventTarget,
    scope: ChangeScope,
    draft: EventDraft,
    invitable: Invitee[],
  ): Promise<ChangeResult> {
    const outside = await this.#outsideFor(
      draft,
      this.#store.organiserOf(target.uid),
    );
    const result = this.#store.update(
      actor,
      target,
      scope,
      draft,
      invitable,
      outside,
      Date.now(),
    );
    await this.#scheduleNextWakeUp();
    return result;
  }

  async retryEmail(
    actor: Actor,
    uid: EventUid,
    recipient: PersonKey,
  ): Promise<RetryResult> {
    const result = this.#store.retryEmail(actor, uid, recipient, Date.now());
    await this.#scheduleNextWakeUp();
    return result;
  }

  async removeEvent(
    actor: Actor,
    target: EventTarget,
    scope: ChangeScope,
  ): Promise<ChangeResult> {
    const result = this.#store.remove(actor, target, scope, Date.now());
    await this.#scheduleNextWakeUp();
    return result;
  }

  async answerEvent(
    actor: Actor,
    uid: EventUid,
    answer: Answer,
  ): Promise<AnswerResult> {
    const result = this.#store.answer(actor, uid, answer, Date.now());
    await this.#scheduleNextWakeUp();
    return result;
  }

  async importEvents(
    actor: Actor,
    organiserName: string,
    groups: ImportGroup[],
  ): Promise<ImportResult> {
    const result = this.#store.importEvents(
      actor,
      organiserName,
      groups,
      Date.now(),
    );
    await this.#scheduleNextWakeUp();
    return result;
  }

  // Anyone on the calendar sees its events, so anyone on it may know how many there are.
  countEvents(_actor: Actor): number {
    return this.#store.countEvents();
  }

  async erase(actor: Actor): Promise<EraseResult> {
    const result = this.#store.erase(actor, Date.now());
    await this.#scheduleNextWakeUp();
    return result;
  }

  // Only another Calendar object calls these, through invitationReceiver. They write only
  // a copy of an event organised on the calendar that sent it, or one invited person's
  // answer, so there is nobody to check by then.
  async receiveInvitation(delivery: Delivery): Promise<DeliveryResult> {
    const uid = await copyUidOf(delivery.from, delivery.uid);
    return this.#store.receiveInvitation(delivery, uid, Date.now());
  }

  async receiveAnswer(notice: AnswerNotice): Promise<void> {
    this.#store.receiveAnswer(notice, Date.now());
    await this.#scheduleNextWakeUp();
  }

  // Call this before any other await, so it commits with the rows that need it.
  #scheduleNextWakeUp(): Promise<void> {
    const due = this.#store.nextWakeUpAt();
    return due === null
      ? this.ctx.storage.deleteAlarm()
      : // The runtime refuses a time of 0.
        this.ctx.storage.setAlarm(Math.max(due, 1));
  }

  // With Calendar off nothing new happens, so copies and answers wait in their queues,
  // untouched, and go once an admin turns it back on. Emails due then don't go, and say
  // so in the People list, as Mail's sending does when Mail is off.
  override async alarm(): Promise<void> {
    await this.#sendEmails();
    if (await this.#calendarOff()) {
      // Each check reads D1, so a long stretch off checks less often.
      const holds = this.ctx.storage.kv.get<number>(OFF_HOLDS) ?? 0;
      this.ctx.storage.kv.put(OFF_HOLDS, holds + 1);
      await this.ctx.storage.setAlarm(
        Date.now() +
          Math.min(FIRST_OFF_HOLD_MS * 2 ** holds, LONGEST_OFF_HOLD_MS),
      );
      return;
    }
    this.ctx.storage.kv.delete(OFF_HOLDS);
    await this.#sendDeliveries();
    await this.#sendAnswers();
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
        "Invitation emails stopped. They'll be looked at again.",
        error,
      );
    }
  }

  // A directory that can't say waits the same way, so nothing goes without an answer.
  async #calendarOff(): Promise<boolean> {
    try {
      return await isAppOff(this.env.DB, "calendar");
    } catch (error) {
      console.error(
        "Could not check that Calendar is on. Trying again.",
        error,
      );
      return true;
    }
  }

  // Someone removed from the organisation has no personal calendar any more, so their
  // delivery is dropped. The first invitation that reaches anyone else makes theirs.
  async #sendDeliveries(): Promise<void> {
    const due = this.#store.dueDeliveries(Date.now(), DELIVERIES_PER_WAKE_UP);
    for (const queued of due) {
      try {
        const delivery = this.#store.deliveryFor(queued);
        const calendarId =
          delivery.kind === "event"
            ? await makePersonalCalendar(this.env.DB, queued.userId)
            : await findPersonalCalendar(this.env.DB, queued.userId);
        if (calendarId && calendarId !== queued.calendarId) {
          await invitationReceiver(this.env, calendarId).deliver(
            this.#store.deliveryFor(queued),
          );
        }
        this.#store.finishDelivery(queued);
      } catch (error) {
        console.error("Could not deliver an invitation. Trying again.", error);
        this.#store.postponeDelivery(queued, Date.now());
      }
    }
  }

  async #sendAnswers(): Promise<void> {
    for (const notice of this.#store.dueAnswers(
      Date.now(),
      ANSWERS_PER_WAKE_UP,
    )) {
      try {
        await invitationReceiver(this.env, notice.calendarId).answer(notice);
        this.#store.finishAnswer(notice);
      } catch (error) {
        console.error("Could not send an answer. Trying again.", error);
        this.#store.postponeAnswer(notice, Date.now());
      }
    }
  }
}
