import { and, asc, eq, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { handedOverName } from "./handover-text";
import {
  type DriveId,
  driveAccess,
  drives,
  type UserId,
} from "../../../../src/db/schema";

const TEAM_COLOURS = 6;

export type DriveToClaim = {
  id: DriveId;
  kind: "personal" | "team";
  name: string;
  usedBytes: number;
  fileCount: number;
};

const NAME_WHEN_PERSON_UNKNOWN = "Files from someone who was removed";

const nextColour = sql`((SELECT count(*) FROM drives AS team WHERE team.kind = 'team') % ${TEAM_COLOURS}) + 1`;

// A team folder they managed alone stays with the people already on it, so nobody new sees
// its files. Can edit counts for more than Can view, then whoever joined first.
const nextManagers = (db: DrizzleD1Database, personId: UserId) =>
  db.run(
    sql`UPDATE drive_access SET role = 'manager'
        WHERE user_id = (
          SELECT next.user_id FROM drive_access AS next
          WHERE next.drive_id = drive_access.drive_id AND next.user_id != ${personId}
          ORDER BY (next.role = 'editor') DESC, next.created_at, next.user_id
          LIMIT 1
        )
        AND drive_id IN (
          SELECT mine.drive_id FROM drive_access AS mine
          WHERE mine.user_id = ${personId} AND mine.role = 'manager'
            AND NOT EXISTS (
              SELECT 1 FROM drive_access AS others
              WHERE others.drive_id = mine.drive_id
                AND others.user_id != ${personId}
                AND others.role = 'manager'
            )
        )`,
  );

// For someone with nothing to hand over: their team folders still need a manager.
export async function appointNextManagers(
  database: D1Database,
  personId: UserId,
): Promise<void> {
  await nextManagers(drizzle(database), personId);
}

// Everything here is one D1 batch, so it all happens or none of it does. Each part finds
// its own work from what's there now, so a repeat after the next step failed finds none:
// the My files is a team folder by then, and each folder has its new manager.
export async function handOverFiles(
  database: D1Database,
  personId: UserId,
  personName: string,
  recipientId: UserId,
): Promise<void> {
  const db = drizzle(database);
  const myFiles = sql`(SELECT id FROM drives WHERE owner_id = ${personId} AND kind = 'personal')`;
  await db.batch([
    db.run(
      sql`INSERT INTO drive_access (drive_id, user_id, role)
          SELECT id, ${recipientId}, 'manager' FROM drives
          WHERE owner_id = ${personId} AND kind = 'personal'
          ON CONFLICT (drive_id, user_id) DO UPDATE SET role = 'manager'`,
    ),
    db.run(
      sql`DELETE FROM drive_access WHERE user_id = ${personId} AND drive_id = ${myFiles}`,
    ),
    db
      .update(drives)
      .set({
        kind: "team",
        ownerId: null,
        limitBytes: null,
        name: handedOverName(personName),
        colour: nextColour,
      })
      .where(and(eq(drives.ownerId, personId), eq(drives.kind, "personal"))),
    // A team folder only they were on goes to the same person.
    db.run(
      sql`INSERT INTO drive_access (drive_id, user_id, role)
          SELECT mine.drive_id, ${recipientId}, 'manager' FROM drive_access AS mine
          JOIN drives ON drives.id = mine.drive_id AND drives.kind = 'team'
          WHERE mine.user_id = ${personId}
            AND NOT EXISTS (
              SELECT 1 FROM drive_access AS others
              WHERE others.drive_id = mine.drive_id AND others.user_id != ${personId}
            )
          ON CONFLICT (drive_id, user_id) DO UPDATE SET role = 'manager'`,
    ),
    nextManagers(db, personId),
  ]);
}

export type FilesToHand = {
  myFiles: boolean;
  aloneIn: number;
  managedAlone: number;
};

// For the removal dialog, which needs a recipient only if something would have nobody.
export async function readFilesToHand(
  database: D1Database,
): Promise<Map<string, FilesToHand>> {
  const db = drizzle(database);
  const [owners, access] = await db.batch([
    db
      .select({ ownerId: drives.ownerId })
      .from(drives)
      .where(eq(drives.kind, "personal")),
    db
      .select({
        driveId: driveAccess.driveId,
        userId: driveAccess.userId,
        role: driveAccess.role,
      })
      .from(driveAccess)
      .innerJoin(drives, eq(drives.id, driveAccess.driveId))
      .where(eq(drives.kind, "team")),
  ]);
  const byDrive = Map.groupBy(access, (row) => row.driveId);
  const files = new Map<string, FilesToHand>();
  const of = (userId: string) => {
    const known = files.get(userId);
    if (known) return known;
    const fresh = { myFiles: false, aloneIn: 0, managedAlone: 0 };
    files.set(userId, fresh);
    return fresh;
  };
  for (const { ownerId } of owners) {
    if (ownerId) of(ownerId).myFiles = true;
  }
  for (const rows of byDrive.values()) {
    const managers = rows.filter((row) => row.role === "manager");
    const [only] = rows;
    if (rows.length === 1 && only) of(only.userId).aloneIn += 1;
    else if (managers.length === 1 && managers[0]) {
      of(managers[0].userId).managedAlone += 1;
    }
  }
  return files;
}

// Removed before handing over existed: no manager, and so nobody who can do anything with
// it. A personal drive's person left nothing to name it after.
export async function listDrivesToClaim(
  database: D1Database,
): Promise<DriveToClaim[]> {
  return drizzle(database)
    .select({
      id: drives.id,
      kind: drives.kind,
      name: drives.name,
      usedBytes: drives.usedBytes,
      fileCount: drives.fileCount,
    })
    .from(drives)
    .where(
      sql`NOT EXISTS (
        SELECT 1 FROM drive_access
        WHERE drive_access.drive_id = ${drives.id} AND drive_access.role = 'manager'
      )`,
    )
    .orderBy(asc(drives.createdAt));
}

// A second admin choosing someone else finds it already claimed, and changes nothing.
export async function claimDrive(
  database: D1Database,
  driveId: DriveId,
  recipientId: UserId,
): Promise<void> {
  const db = drizzle(database);
  const unclaimed = sql`NOT EXISTS (
    SELECT 1 FROM drive_access
    WHERE drive_access.drive_id = ${driveId} AND drive_access.role = 'manager'
  )`;
  await db.batch([
    db
      .update(drives)
      .set({
        kind: "team",
        ownerId: null,
        limitBytes: null,
        name: NAME_WHEN_PERSON_UNKNOWN,
        colour: nextColour,
      })
      .where(
        and(eq(drives.id, driveId), eq(drives.kind, "personal"), unclaimed),
      ),
    db.run(
      sql`INSERT INTO drive_access (drive_id, user_id, role)
          SELECT id, ${recipientId}, 'manager' FROM drives
          WHERE id = ${driveId} AND ${unclaimed}
          ON CONFLICT (drive_id, user_id) DO UPDATE SET role = 'manager'`,
    ),
  ]);
}
