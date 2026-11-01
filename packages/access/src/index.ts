import { and, eq, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import {
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

export type { DriveId, DriveKind, DriveRole, MailboxId, MailboxRole, UserId };

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
    readonly role: DriveRole,
  ) {
    if (token !== ISSUE)
      throw new Error("Only the access check issues grants.");
    Object.freeze(this);
  }
}

export type DriveGrant = DriveGrantRecord;

export type DriveAccess =
  { allowed: true; grant: DriveGrant } | { allowed: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseMailboxId(raw: string): MailboxId | null {
  return UUID.test(raw) ? (raw as MailboxId) : null;
}

export function parseDriveId(raw: string): DriveId | null {
  return UUID.test(raw) ? (raw as DriveId) : null;
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
    .from(driveAccess)
    .innerJoin(user, eq(user.id, driveAccess.userId))
    .where(
      and(eq(driveAccess.userId, userId), eq(driveAccess.driveId, driveId)),
    );
  if (!row || isBanned(row)) return { allowed: false };
  return {
    allowed: true,
    grant: new DriveGrantRecord(ISSUE, userId, driveId, row.role),
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
