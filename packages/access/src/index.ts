import { and, asc, eq, ne, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import {
  calendarAccess,
  type CalendarId,
  type CalendarKind,
  type CalendarRole,
  calendars,
  driveAccess,
  drives,
  type DriveId,
  type DriveKind,
  type DriveRole,
  mailboxAccess,
  type MailboxId,
  type MailboxRole,
  user,
  type UserId,
} from "../../../src/db/schema";

export type {
  CalendarId,
  CalendarKind,
  CalendarRole,
  DriveId,
  DriveKind,
  DriveRole,
  MailboxId,
  MailboxRole,
  UserId,
};

export type AccessLevel = "view" | "edit";

// Anything else, such as a role from a later version, can do nothing here.
export function levelOfRole(
  role: DriveRole | CalendarRole,
): AccessLevel | null {
  switch (role) {
    case "manager":
    case "editor":
      return "edit";
    case "viewer":
      return "view";
    default:
      return null;
  }
}

const ISSUE = Symbol();

// Mailbox code takes a grant rather than a mailbox id. The private field makes
// the type nominal, so code that skips the check, or copies a grant to change
// its values, does not compile. The constructor is reachable at runtime through
// grant.constructor, so it refuses any caller without this module's token. A
// type cast can still pass off a lookalike object as a grant.
class Grant {
  readonly #issuedByCheck = true;

  constructor(
    token: symbol,
    readonly userId: UserId,
    readonly mailboxId: MailboxId,
    readonly role: MailboxRole,
  ) {
    if (token !== ISSUE)
      throw new Error("Only the access check issues grants.");
    Object.freeze(this);
  }
}

export type MailboxGrant = Grant;

export type MailboxAccess =
  { allowed: true; grant: MailboxGrant } | { allowed: false };

// Its own class, so a drive's grant can't open a mailbox or the other way round. The
// same rules as Grant above apply.
class DriveGrantRecord {
  readonly #issuedByCheck = true;

  constructor(
    token: symbol,
    readonly userId: UserId,
    readonly driveId: DriveId,
    // Null is a signed-in person who isn't on the drive's list. They reach only what the
    // Drive object says has been shared with them, which starts as nothing.
    readonly role: DriveRole | null,
  ) {
    if (token !== ISSUE)
      throw new Error("Only the access check issues grants.");
    Object.freeze(this);
  }
}

export type DriveGrant = DriveGrantRecord;

export type DriveAccess =
  { allowed: true; grant: DriveGrant } | { allowed: false };

// The same rules as Grant above. A calendar has no shares, so only someone on its list
// gets one.
class CalendarGrantRecord {
  readonly #issuedByCheck = true;

  constructor(
    token: symbol,
    readonly userId: UserId,
    readonly calendarId: CalendarId,
    readonly role: CalendarRole,
  ) {
    if (token !== ISSUE)
      throw new Error("Only the access check issues grants.");
    Object.freeze(this);
  }
}

export type CalendarGrant = CalendarGrantRecord;

export type CalendarAccess =
  { allowed: true; grant: CalendarGrant } | { allowed: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseMailboxId(raw: string): MailboxId | null {
  return UUID.test(raw) ? (raw as MailboxId) : null;
}

export function parseDriveId(raw: string): DriveId | null {
  return UUID.test(raw) ? (raw as DriveId) : null;
}

export function parseCalendarId(raw: string): CalendarId | null {
  return UUID.test(raw) ? (raw as CalendarId) : null;
}

// Matches Better Auth's admin plugin: a ban with no end date never expires, and
// one that has passed no longer blocks, though the row stays set until sign-in.
export function isBanned(person: {
  banned?: boolean | null;
  banExpires?: Date | null;
}): boolean {
  if (!person.banned) return false;
  return !person.banExpires || person.banExpires.getTime() >= Date.now();
}

// Everyone a person could add to a team folder or a team calendar. A suspended person
// can't open anything, so they aren't offered, and the rest are the same few people
// everyone at a small organisation knows.
export async function readOthers(database: D1Database, me: UserId) {
  const rows = await drizzle(database)
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(user)
    .where(ne(user.id, me))
    .orderBy(asc(user.name));
  return rows
    .filter((row) => !isBanned(row))
    .map(({ banned: _banned, banExpires: _banExpires, ...person }) => person);
}

export async function checkMailboxAccess(
  database: D1Database,
  userId: UserId,
  mailboxId: MailboxId,
): Promise<MailboxAccess> {
  const [row] = await drizzle(database)
    .select({
      role: mailboxAccess.role,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(mailboxAccess)
    .innerJoin(user, eq(user.id, mailboxAccess.userId))
    .where(
      and(
        eq(mailboxAccess.userId, userId),
        eq(mailboxAccess.mailboxId, mailboxId),
      ),
    );
  if (!row || isBanned(row)) return { allowed: false };
  return {
    allowed: true,
    grant: new Grant(ISSUE, userId, mailboxId, row.role),
  };
}

export async function checkDriveAccess(
  database: D1Database,
  userId: UserId,
  driveId: DriveId,
): Promise<DriveAccess> {
  const [row] = await drizzle(database)
    .select({
      role: driveAccess.role,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(drives)
    .innerJoin(user, eq(user.id, userId))
    .leftJoin(
      driveAccess,
      and(eq(driveAccess.driveId, drives.id), eq(driveAccess.userId, userId)),
    )
    .where(eq(drives.id, driveId));
  if (!row || isBanned(row)) return { allowed: false };
  return {
    allowed: true,
    grant: new DriveGrantRecord(ISSUE, userId, driveId, row.role),
  };
}

export async function checkCalendarAccess(
  database: D1Database,
  userId: UserId,
  calendarId: CalendarId,
): Promise<CalendarAccess> {
  const [row] = await drizzle(database)
    .select({
      role: calendarAccess.role,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(calendarAccess)
    .innerJoin(calendars, eq(calendars.id, calendarAccess.calendarId))
    .innerJoin(user, eq(user.id, calendarAccess.userId))
    .where(
      and(
        eq(calendarAccess.userId, userId),
        eq(calendarAccess.calendarId, calendarId),
      ),
    );
  if (!row || isBanned(row)) return { allowed: false };
  return {
    allowed: true,
    grant: new CalendarGrantRecord(ISSUE, userId, calendarId, row.role),
  };
}

// Safe to repeat under the unique index, so two tabs can't make two. Put these first in
// a batch, so whatever follows sees the drive.
export const ensurePersonalDrive = (db: DrizzleD1Database, userId: UserId) =>
  [
    db
      .insert(drives)
      .values({
        kind: "personal",
        name: "My files",
        colour: 1,
        ownerId: userId,
      })
      .onConflictDoNothing(),
    db.run(
      sql`INSERT INTO drive_access (drive_id, user_id, role)
          SELECT id, ${userId}, 'manager' FROM drives
          WHERE owner_id = ${userId} AND kind = 'personal'
          ON CONFLICT DO NOTHING`,
    ),
  ] as const;

// Not avatar-1, because a blue personal calendar was hard to tell from a blue team one.
export const PERSONAL_CALENDAR_COLOUR = 4;

// Safe to repeat for the same reason as ensurePersonalDrive, and one batch, so the
// calendar is never left without its person on it.
export async function ensurePersonalCalendar(
  database: D1Database,
  userId: UserId,
): Promise<CalendarId> {
  const db = drizzle(database);
  const [, , found] = await db.batch([
    db
      .insert(calendars)
      .values({
        kind: "personal",
        colour: PERSONAL_CALENDAR_COLOUR,
        ownerId: userId,
      })
      .onConflictDoNothing(),
    db.run(
      sql`INSERT INTO calendar_access (calendar_id, user_id, role)
          SELECT id, ${userId}, 'manager' FROM calendars
          WHERE owner_id = ${userId} AND kind = 'personal'
          ON CONFLICT DO NOTHING`,
    ),
    db
      .select({ id: calendars.id })
      .from(calendars)
      .where(
        and(eq(calendars.ownerId, userId), eq(calendars.kind, "personal")),
      ),
  ]);
  const id = found[0]?.id;
  if (!id) throw new Error("A personal calendar should exist by now.");
  return id;
}
