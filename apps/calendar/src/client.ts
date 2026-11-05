import {
  type CalendarGrant,
  type CalendarId,
  type CalendarRole,
  checkCalendarAccess,
  levelOfRole,
  type UserId,
} from "@cloudysuite/access";
import type { SearchTerm } from "@cloudysuite/search";
import type { AnswerNotice, Delivery, DeliveryResult } from "./invitations";
import type { Actor, ImportGroup, ImportResult } from "./store";
import { calendarStub } from "./stub";
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
  PersonKey,
  RangeListing,
  RetryResult,
  TimeZone,
} from "./types";

export type CalendarClient = {
  calendarId: CalendarId;
  role: CalendarRole;
  listRange(range: DayRange): Promise<RangeListing>;
  search(terms: SearchTerm[], timeZone: TimeZone): Promise<EventSearchResult>;
  invitations(timeZone: TimeZone): Promise<Occurrence[]>;
  // `invitable` is who the directory says can be invited now, out of the draft's people.
  create(
    organiserName: string,
    draft: EventDraft,
    invitable: Invitee[],
  ): Promise<CreateResult>;
  update(
    target: EventTarget,
    scope: ChangeScope,
    draft: EventDraft,
    invitable: Invitee[],
  ): Promise<ChangeResult>;
  remove(target: EventTarget, scope: ChangeScope): Promise<ChangeResult>;
  importEvents(
    organiserName: string,
    groups: ImportGroup[],
  ): Promise<ImportResult>;
  answer(uid: EventUid, answer: Answer): Promise<AnswerResult>;
  retryEmail(uid: EventUid, recipient: PersonKey): Promise<RetryResult>;
  countEvents(): Promise<number>;
  // Only once D1 no longer has the calendar.
  erase(): Promise<EraseResult>;
};

// The only way for user-facing code to reach a calendar. A grant cannot cross RPC, so D1's
// part of the check happens here, on the caller's side, and every call tells the object
// who is asking.
export function openCalendar(env: Env, grant: CalendarGrant): CalendarClient {
  const stub = calendarStub(env, grant.calendarId);
  const actor: Actor = {
    userId: grant.userId,
    role: grant.role,
    calendarId: grant.calendarId,
  };
  return {
    calendarId: grant.calendarId,
    role: grant.role,
    listRange: async (range) =>
      (await stub.listRange(actor, range)) as RangeListing,
    search: async (terms, timeZone) =>
      (await stub.searchEvents(actor, terms, timeZone)) as EventSearchResult,
    invitations: async (timeZone) =>
      (await stub.invitations(actor, timeZone)) as Occurrence[],
    create: async (organiserName, draft, invitable) =>
      (await stub.createEvent(
        actor,
        organiserName,
        draft,
        invitable,
      )) as CreateResult,
    update: async (target, scope, draft, invitable) =>
      (await stub.updateEvent(
        actor,
        target,
        scope,
        draft,
        invitable,
      )) as ChangeResult,
    remove: async (target, scope) =>
      (await stub.removeEvent(actor, target, scope)) as ChangeResult,
    importEvents: async (organiserName, groups) =>
      (await stub.importEvents(actor, organiserName, groups)) as ImportResult,
    answer: async (uid, answer) =>
      (await stub.answerEvent(actor, uid, answer)) as AnswerResult,
    retryEmail: async (uid, recipient) =>
      (await stub.retryEmail(actor, uid, recipient)) as RetryResult,
    countEvents: () => stub.countEvents(actor),
    erase: async () => (await stub.erase(actor)) as EraseResult,
  };
}

// For one request. A calendar that doesn't exist, someone not on it, or a banned person
// gets null.
export async function openCalendarAsPerson(
  env: Env,
  userId: UserId,
  calendarId: CalendarId,
): Promise<CalendarClient | null> {
  const access = await checkCalendarAccess(env.DB, userId, calendarId);
  return access.allowed ? openCalendar(env, access.grant) : null;
}

// Whether someone who made a change can still make it, asked again before its emails go.
// A calendar that's gone, someone taken off it, and someone suspended can't.
export async function canStillEdit(
  database: D1Database,
  userId: UserId,
  calendarId: CalendarId,
): Promise<boolean> {
  const access = await checkCalendarAccess(database, userId, calendarId);
  return access.allowed && levelOfRole(access.grant.role) === "edit";
}

// For one Calendar object to hand another an invitation copy or an answer. It grants no
// person anything, and can't write an event of that calendar's own, only a copy of one
// organised on the calendar that sends it. boundaries.test.ts allows only the Calendar
// object to call it, so no server function can.
export function invitationReceiver(env: Env, calendarId: CalendarId) {
  const stub = calendarStub(env, calendarId);
  return {
    deliver: async (delivery: Delivery) =>
      (await stub.receiveInvitation(delivery)) as DeliveryResult,
    answer: async (notice: AnswerNotice) => {
      await stub.receiveAnswer(notice);
    },
  };
}
