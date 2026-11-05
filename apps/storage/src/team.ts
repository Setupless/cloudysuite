import { type DriveId, type DriveRole, type UserId } from "@cloudysuite/access";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { driveAccess, drives, user } from "../../../src/db/schema";
import type { Person } from "./types";

export type TeamChange = "done" | "lastManager" | "notOnIt";

export type TeamMember = { person: Person; role: DriveRole };

export async function readTeam(
  database: D1Database,
  driveId: DriveId,
): Promise<TeamMember[]> {
  const rows = await drizzle(database)
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: driveAccess.role,
    })
    .from(driveAccess)
    .innerJoin(user, eq(user.id, driveAccess.userId))
    .where(eq(driveAccess.driveId, driveId))
    .orderBy(asc(driveAccess.createdAt));
  return rows.map(({ role, ...person }) => ({ person, role }));
}

// D1 settles a race between two statements by running them one after the other, so each
// of these guards sees what the other just did. Two managers stepping down together
// can't leave nobody.
const isNotTheLastManager = sql`(${driveAccess.role} != 'manager' OR EXISTS (
  SELECT 1 FROM drive_access AS others
  WHERE others.drive_id = ${driveAccess.driveId}
    AND others.user_id != ${driveAccess.userId}
    AND others.role = 'manager'
))`;

async function whyNothingChanged(
  database: D1Database,
  driveId: DriveId,
  userId: UserId,
): Promise<TeamChange> {
  const [row] = await drizzle(database)
    .select({ role: driveAccess.role })
    .from(driveAccess)
    .where(
      and(eq(driveAccess.driveId, driveId), eq(driveAccess.userId, userId)),
    );
  return row ? "lastManager" : "notOnIt";
}

export async function setTeamRole(
  database: D1Database,
  driveId: DriveId,
  userId: UserId,
  role: DriveRole,
): Promise<TeamChange> {
  const changed = await drizzle(database)
    .update(driveAccess)
    .set({ role })
    .where(
      and(
        eq(driveAccess.driveId, driveId),
        eq(driveAccess.userId, userId),
        role === "manager" ? undefined : isNotTheLastManager,
      ),
    )
    .returning({ userId: driveAccess.userId });
  return changed.length > 0
    ? "done"
    : whyNothingChanged(database, driveId, userId);
}

export async function removeFromTeam(
  database: D1Database,
  driveId: DriveId,
  userId: UserId,
): Promise<TeamChange> {
  const removed = await drizzle(database)
    .delete(driveAccess)
    .where(
      and(
        eq(driveAccess.driveId, driveId),
        eq(driveAccess.userId, userId),
        isNotTheLastManager,
      ),
    )
    .returning({ userId: driveAccess.userId });
  return removed.length > 0
    ? "done"
    : whyNothingChanged(database, driveId, userId);
}

// Someone already on it keeps the role they have, so adding a team can't demote anyone.
// Only a team folder takes members: My files is one person's until it's handed over.
export async function addToTeam(
  database: D1Database,
  driveId: DriveId,
  people: readonly UserId[],
  role: DriveRole,
): Promise<void> {
  const db = drizzle(database);
  const [first, ...rest] = people.map((userId) =>
    db.run(
      sql`INSERT INTO drive_access (drive_id, user_id, role)
          SELECT ${driveId}, ${userId}, ${role} FROM drives
          WHERE id = ${driveId} AND kind = 'team'
          ON CONFLICT DO NOTHING`,
    ),
  );
  if (first) await db.batch([first, ...rest]);
}

export async function renameTeam(
  database: D1Database,
  driveId: DriveId,
  name: string,
): Promise<void> {
  await drizzle(database)
    .update(drives)
    .set({ name })
    .where(and(eq(drives.id, driveId), eq(drives.kind, "team")));
}

export async function deleteTeam(
  database: D1Database,
  driveId: DriveId,
): Promise<void> {
  await drizzle(database)
    .delete(drives)
    .where(and(eq(drives.id, driveId), eq(drives.kind, "team")));
}

export async function readDriveKind(database: D1Database, driveId: DriveId) {
  const [row] = await drizzle(database)
    .select({ kind: drives.kind, name: drives.name })
    .from(drives)
    .where(eq(drives.id, driveId));
  return row ?? null;
}
