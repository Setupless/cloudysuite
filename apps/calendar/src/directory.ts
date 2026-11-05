import {
  type CalendarId,
  type CalendarRole,
  ensurePersonalCalendar,
  isBanned,
  PERSONAL_CALENDAR_COLOUR,
  TEAM_CALENDAR_COLOURS,
  type UserId,
} from "@cloudysuite/access";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { calendarAccess, calendars, user } from "../../../src/db/schema";
import {
  type CalendarEntry,
  type Invitee,
  MAX_PERSON_NAME_LENGTH,
  type Member,
} from "./types";

export type TeamChange = "done" | "lastManager" | "notOnIt";

// Out of the people asked for, those who can be invited now. Someone suspended can't
// open anything, so they aren't invited, and someone removed has no row.
export async function readInvitable(
  database: D1Database,
  people: readonly UserId[],
): Promise<Invitee[]> {
  if (people.length === 0) return [];
  const rows = await drizzle(database)
    .select({
      id: user.id,
      name: user.name,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(user)
    .where(inArray(user.id, [...people]));
  return rows
    .filter((row) => !isBanned(row))
    .map((row) => ({
      userId: row.id,
      name: row.name.slice(0, MAX_PERSON_NAME_LENGTH),
    }));
}

export async function findPersonalCalendar(
  database: D1Database,
  userId: UserId,
): Promise<CalendarId | null> {
  const [row] = await drizzle(database)
    .select({ id: calendars.id })
    .from(calendars)
    .where(and(eq(calendars.ownerId, userId), eq(calendars.kind, "personal")));
  return row?.id ?? null;
}

// The first invitation that reaches someone counts as first use. Someone removed from the
// organisation gets null, because their calendar has been handed over.
export async function makePersonalCalendar(
  database: D1Database,
  userId: UserId,
): Promise<CalendarId | null> {
  const [person] = await drizzle(database)
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId));
  return person ? ensurePersonalCalendar(database, userId) : null;
}

// The team calendars where this person can change events, longest held first.
export async function editableTeams(
  database: D1Database,
  userId: UserId,
): Promise<CalendarId[]> {
  const rows = await drizzle(database)
    .select({ id: calendars.id })
    .from(calendarAccess)
    .innerJoin(calendars, eq(calendars.id, calendarAccess.calendarId))
    .where(
      and(
        eq(calendarAccess.userId, userId),
        eq(calendars.kind, "team"),
        inArray(calendarAccess.role, ["editor", "manager"]),
      ),
    )
    .orderBy(asc(calendarAccess.createdAt), asc(calendars.id));
  return rows.map((row) => row.id);
}

// Every calendar this person is on. Their personal calendar is always first, even before
// it is made, because looking at Calendar changes nothing.
export async function readMyCalendars(
  database: D1Database,
  me: { id: UserId; name: string },
): Promise<CalendarEntry[]> {
  const rows = await drizzle(database)
    .select({
      id: calendars.id,
      kind: calendars.kind,
      name: calendars.name,
      colour: calendars.colour,
      ownerId: calendars.ownerId,
      role: calendarAccess.role,
      hidden: calendarAccess.hidden,
    })
    .from(calendarAccess)
    .innerJoin(calendars, eq(calendars.id, calendarAccess.calendarId))
    .where(eq(calendarAccess.userId, me.id))
    .orderBy(asc(calendars.name));
  const entries = rows.map(
    ({ ownerId, ...row }): CalendarEntry & { mine: boolean } => ({
      ...row,
      name: row.name ?? me.name,
      mine: row.kind === "personal" && ownerId === me.id,
    }),
  );
  const { mine: _mine, ...personal } = entries.find((entry) => entry.mine) ?? {
    id: null,
    kind: "personal",
    name: me.name,
    colour: PERSONAL_CALENDAR_COLOUR,
    role: "manager",
    hidden: false,
    mine: true,
  };
  return [
    personal,
    ...entries
      .filter((entry) => !entry.mine)
      .map(({ mine: _mine, ...entry }) => entry),
  ];
}

export async function createTeam(
  database: D1Database,
  me: UserId,
  name: string,
): Promise<CalendarId> {
  const db = drizzle(database);
  const [existing] = await db
    .select({ total: count() })
    .from(calendars)
    .where(eq(calendars.kind, "team"));
  const id = crypto.randomUUID() as CalendarId;
  await db.batch([
    db.insert(calendars).values({
      id,
      kind: "team",
      name,
      colour:
        TEAM_CALENDAR_COLOURS[
          (existing?.total ?? 0) % TEAM_CALENDAR_COLOURS.length
        ] ?? 1,
    }),
    db
      .insert(calendarAccess)
      .values({ calendarId: id, userId: me, role: "manager" }),
  ]);
  return id;
}

export async function readKind(database: D1Database, calendarId: CalendarId) {
  const [row] = await drizzle(database)
    .select({ kind: calendars.kind })
    .from(calendars)
    .where(eq(calendars.id, calendarId));
  return row?.kind ?? null;
}

const isTeam = (calendarId: CalendarId) =>
  and(eq(calendars.id, calendarId), eq(calendars.kind, "team"));

export async function renameTeam(
  database: D1Database,
  calendarId: CalendarId,
  name: string,
): Promise<void> {
  await drizzle(database)
    .update(calendars)
    .set({ name })
    .where(isTeam(calendarId));
}

export async function setColour(
  database: D1Database,
  calendarId: CalendarId,
  colour: number,
): Promise<void> {
  await drizzle(database)
    .update(calendars)
    .set({ colour })
    .where(eq(calendars.id, calendarId));
}

export async function deleteTeam(
  database: D1Database,
  calendarId: CalendarId,
): Promise<void> {
  await drizzle(database).delete(calendars).where(isTeam(calendarId));
}

export async function setHidden(
  database: D1Database,
  calendarId: CalendarId,
  userId: UserId,
  hidden: boolean,
): Promise<void> {
  await drizzle(database)
    .update(calendarAccess)
    .set({ hidden })
    .where(
      and(
        eq(calendarAccess.calendarId, calendarId),
        eq(calendarAccess.userId, userId),
      ),
    );
}

export async function readMembers(
  database: D1Database,
  calendarId: CalendarId,
): Promise<Member[]> {
  const rows = await drizzle(database)
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: calendarAccess.role,
    })
    .from(calendarAccess)
    .innerJoin(user, eq(user.id, calendarAccess.userId))
    .where(eq(calendarAccess.calendarId, calendarId))
    .orderBy(asc(calendarAccess.createdAt));
  return rows.map(({ role, ...person }) => ({ person, role }));
}

export async function readAddable(
  database: D1Database,
  people: readonly UserId[],
): Promise<UserId[]> {
  const rows = await drizzle(database)
    .select({ id: user.id, banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(inArray(user.id, [...people]));
  return rows.filter((row) => !isBanned(row)).map((row) => row.id);
}

// Someone already on it keeps the role they have, so adding people can't demote anyone.
// A personal calendar is one person's until it's handed over.
export async function addToTeam(
  database: D1Database,
  calendarId: CalendarId,
  people: readonly UserId[],
  role: CalendarRole,
): Promise<void> {
  const db = drizzle(database);
  const [first, ...rest] = people.map((userId) =>
    db.run(
      sql`INSERT INTO calendar_access (calendar_id, user_id, role)
          SELECT ${calendarId}, ${userId}, ${role} FROM calendars
          WHERE id = ${calendarId} AND kind = 'team'
          ON CONFLICT DO NOTHING`,
    ),
  );
  if (first) await db.batch([first, ...rest]);
}

// D1 runs two statements one after the other, so each guard sees what the other did. Two
// managers stepping down together can't leave nobody.
const isNotTheLastManager = sql`(${calendarAccess.role} != 'manager' OR EXISTS (
  SELECT 1 FROM calendar_access AS others
  WHERE others.calendar_id = ${calendarAccess.calendarId}
    AND others.user_id != ${calendarAccess.userId}
    AND others.role = 'manager'
))`;

async function whyNothingChanged(
  database: D1Database,
  calendarId: CalendarId,
  userId: UserId,
): Promise<TeamChange> {
  const [row] = await drizzle(database)
    .select({ role: calendarAccess.role })
    .from(calendarAccess)
    .where(
      and(
        eq(calendarAccess.calendarId, calendarId),
        eq(calendarAccess.userId, userId),
      ),
    );
  return row ? "lastManager" : "notOnIt";
}

export async function setMemberRole(
  database: D1Database,
  calendarId: CalendarId,
  userId: UserId,
  role: CalendarRole,
): Promise<TeamChange> {
  const changed = await drizzle(database)
    .update(calendarAccess)
    .set({ role })
    .where(
      and(
        eq(calendarAccess.calendarId, calendarId),
        eq(calendarAccess.userId, userId),
        role === "manager" ? undefined : isNotTheLastManager,
      ),
    )
    .returning({ userId: calendarAccess.userId });
  return changed.length > 0
    ? "done"
    : whyNothingChanged(database, calendarId, userId);
}

export async function removeMember(
  database: D1Database,
  calendarId: CalendarId,
  userId: UserId,
): Promise<TeamChange> {
  const removed = await drizzle(database)
    .delete(calendarAccess)
    .where(
      and(
        eq(calendarAccess.calendarId, calendarId),
        eq(calendarAccess.userId, userId),
        isNotTheLastManager,
      ),
    )
    .returning({ userId: calendarAccess.userId });
  return removed.length > 0
    ? "done"
    : whyNothingChanged(database, calendarId, userId);
}
