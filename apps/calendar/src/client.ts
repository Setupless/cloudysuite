import {
  type CalendarGrant,
  type CalendarId,
  type CalendarRole,
  checkCalendarAccess,
  type UserId,
} from "@cloudysuite/access";
import type { Actor } from "./store";
import { calendarStub } from "./stub";
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

export type CalendarClient = {
  calendarId: CalendarId;
  role: CalendarRole;
  listRange(range: DayRange): Promise<RangeListing>;
  create(draft: EventDraft): Promise<CreateResult>;
  update(
    target: EventTarget,
    scope: ChangeScope,
    draft: EventDraft,
  ): Promise<ChangeResult>;
  remove(target: EventTarget, scope: ChangeScope): Promise<ChangeResult>;
  // Only once D1 no longer has the calendar.
  erase(): Promise<EraseResult>;
};

// The only way for user-facing code to reach a calendar. A grant cannot cross RPC, so D1's
// part of the check happens here, on the caller's side, and every call tells the object
// who is asking.
export function openCalendar(env: Env, grant: CalendarGrant): CalendarClient {
  const stub = calendarStub(env, grant.calendarId);
  const actor: Actor = { userId: grant.userId, role: grant.role };
  return {
    calendarId: grant.calendarId,
    role: grant.role,
    listRange: async (range) =>
      (await stub.listRange(actor, range)) as RangeListing,
    create: async (draft) =>
      (await stub.createEvent(actor, draft)) as CreateResult,
    update: async (target, scope, draft) =>
      (await stub.updateEvent(actor, target, scope, draft)) as ChangeResult,
    remove: async (target, scope) =>
      (await stub.removeEvent(actor, target, scope)) as ChangeResult,
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
