import { TEAM_BOARD_COLOURS, TEAM_CALENDAR_COLOURS } from "@cloudysuite/access";
import { and, asc, eq, type Name, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import {
  handedOverName,
  type Holdings,
  nothingToHand,
  SPACE_KINDS,
  type SpaceKind,
  type ToHand,
} from "./handover-text";
import {
  boards,
  calendars,
  type DriveId,
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

const nextTeamColour = (table: string, colours: readonly number[]) =>
  sql.raw(`(SELECT CASE count(*) % ${colours.length}
  ${colours.map((colour, index) => `WHEN ${index} THEN ${colour}`).join(" ")}
  END FROM ${table} AS team WHERE team.kind = 'team')`);

const nextCalendarColour = nextTeamColour("calendars", TEAM_CALENDAR_COLOURS);
const nextBoardColour = nextTeamColour("boards", TEAM_BOARD_COLOURS);

type Db = DrizzleD1Database;

// Files, calendars, and boards are handed over by the same rules. Each kind names its own tables,
// and how a person's own one becomes a team one.
type Space = {
  table: Name;
  access: Name;
  key: Name;
  toTeam: (db: Db, personId: UserId, name: string) => BatchItem<"sqlite">;
};

const SPACES: Record<SpaceKind, Space> = {
  files: {
    table: sql.identifier("drives"),
    access: sql.identifier("drive_access"),
    key: sql.identifier("drive_id"),
    toTeam: (db, personId, name) =>
      db
        .update(drives)
        .set({
          kind: "team",
          ownerId: null,
          limitBytes: null,
          name,
          colour: nextColour,
        })
        .where(and(eq(drives.ownerId, personId), eq(drives.kind, "personal"))),
  },
  calendars: {
    table: sql.identifier("calendars"),
    access: sql.identifier("calendar_access"),
    key: sql.identifier("calendar_id"),
    toTeam: (db, personId, name) =>
      db
        .update(calendars)
        .set({ kind: "team", ownerId: null, name, colour: nextCalendarColour })
        .where(
          and(eq(calendars.ownerId, personId), eq(calendars.kind, "personal")),
        ),
  },
  boards: {
    table: sql.identifier("boards"),
    access: sql.identifier("board_access"),
    key: sql.identifier("board_id"),
    toTeam: (db, personId, name) =>
      db
        .update(boards)
        .set({ kind: "team", ownerId: null, name, colour: nextBoardColour })
        .where(and(eq(boards.ownerId, personId), eq(boards.kind, "personal"))),
  },
};

// A team one they managed alone stays with the people already on it, so nobody new sees
// what's in it. Can edit counts for more than Can view, then whoever joined first.
const nextManagers = (db: Db, { access, key }: Space, personId: UserId) =>
  db.run(
    sql`UPDATE ${access} SET role = 'manager'
        WHERE user_id = (
          SELECT next.user_id FROM ${access} AS next
          WHERE next.${key} = ${access}.${key} AND next.user_id != ${personId}
          ORDER BY (next.role = 'editor') DESC, next.created_at, next.user_id
          LIMIT 1
        )
        AND ${key} IN (
          SELECT mine.${key} FROM ${access} AS mine
          WHERE mine.user_id = ${personId} AND mine.role = 'manager'
            AND NOT EXISTS (
              SELECT 1 FROM ${access} AS others
              WHERE others.${key} = mine.${key}
                AND others.user_id != ${personId}
                AND others.role = 'manager'
            )
        )`,
  );

function handOverIn(
  db: Db,
  kind: SpaceKind,
  personId: UserId,
  personName: string,
  recipientId: UserId,
): BatchItem<"sqlite">[] {
  const space = SPACES[kind];
  const { table, access, key } = space;
  const theirOwn = sql`(SELECT id FROM ${table} WHERE owner_id = ${personId} AND kind = 'personal')`;
  return [
    db.run(
      sql`INSERT INTO ${access} (${key}, user_id, role)
          SELECT id, ${recipientId}, 'manager' FROM ${table}
          WHERE owner_id = ${personId} AND kind = 'personal'
          ON CONFLICT (${key}, user_id) DO UPDATE SET role = 'manager'`,
    ),
    db.run(
      sql`DELETE FROM ${access} WHERE user_id = ${personId} AND ${key} = ${theirOwn}`,
    ),
    space.toTeam(db, personId, handedOverName(kind, personName)),
    // A team one only they were on goes to the same person.
    db.run(
      sql`INSERT INTO ${access} (${key}, user_id, role)
          SELECT mine.${key}, ${recipientId}, 'manager' FROM ${access} AS mine
          JOIN ${table} AS space ON space.id = mine.${key} AND space.kind = 'team'
          WHERE mine.user_id = ${personId}
            AND NOT EXISTS (
              SELECT 1 FROM ${access} AS others
              WHERE others.${key} = mine.${key} AND others.user_id != ${personId}
            )
          ON CONFLICT (${key}, user_id) DO UPDATE SET role = 'manager'`,
    ),
    nextManagers(db, space, personId),
  ];
}

// For someone with nothing to hand over: their team folders, calendars, and boards still
// need a manager.
export async function appointNextManagers(
  database: D1Database,
  personId: UserId,
): Promise<void> {
  const db = drizzle(database);
  await db.batch([
    nextManagers(db, SPACES.files, personId),
    nextManagers(db, SPACES.calendars, personId),
    nextManagers(db, SPACES.boards, personId),
  ]);
}

// Everything here is one D1 batch, so it all happens or none of it does. Each part finds
// its own work from what's there now, so a repeat after the next step failed finds none:
// their own folder, calendar, and board are team ones by then, and each has its new manager.
export async function handOver(
  database: D1Database,
  personId: UserId,
  personName: string,
  recipientId: UserId,
): Promise<void> {
  const db = drizzle(database);
  const [first, ...rest] = SPACE_KINDS.flatMap((kind) =>
    handOverIn(db, kind, personId, personName, recipientId),
  );
  if (first) await db.batch([first, ...rest]);
}

type OwnerRow = { ownerId: string };
type AccessRow = { spaceId: string; userId: string; role: string };

const ownersIn = (db: Db, { table }: Space) =>
  db.all<OwnerRow>(
    sql`SELECT owner_id AS ownerId FROM ${table}
        WHERE kind = 'personal' AND owner_id IS NOT NULL`,
  );

const teamAccessIn = (db: Db, { table, access, key }: Space) =>
  db.all<AccessRow>(
    sql`SELECT a.${key} AS spaceId, a.user_id AS userId, a.role AS role
        FROM ${access} AS a
        JOIN ${table} AS space ON space.id = a.${key} AND space.kind = 'team'`,
  );

function tally(
  toHand: Map<string, ToHand>,
  kind: SpaceKind,
  owners: OwnerRow[],
  access: AccessRow[],
): void {
  const of = (userId: string): Holdings => {
    const known = toHand.get(userId);
    if (known) return known[kind];
    const fresh = nothingToHand();
    toHand.set(userId, fresh);
    return fresh[kind];
  };
  for (const { ownerId } of owners) of(ownerId).personal = true;
  for (const rows of Map.groupBy(access, (row) => row.spaceId).values()) {
    const managers = rows.filter((row) => row.role === "manager");
    const [only] = rows;
    if (rows.length === 1 && only) of(only.userId).aloneIn += 1;
    else if (managers.length === 1 && managers[0]) {
      of(managers[0].userId).managedAlone += 1;
    }
  }
}

// For the removal dialog, which needs a recipient only if something would have nobody.
export async function readToHand(
  database: D1Database,
): Promise<Map<string, ToHand>> {
  const db = drizzle(database);
  const [
    fileOwners,
    fileAccess,
    calendarOwners,
    calendarAccess,
    boardOwners,
    boardAccess,
  ] = await db.batch([
    ownersIn(db, SPACES.files),
    teamAccessIn(db, SPACES.files),
    ownersIn(db, SPACES.calendars),
    teamAccessIn(db, SPACES.calendars),
    ownersIn(db, SPACES.boards),
    teamAccessIn(db, SPACES.boards),
  ]);
  const toHand = new Map<string, ToHand>();
  tally(toHand, "files", fileOwners, fileAccess);
  tally(toHand, "calendars", calendarOwners, calendarAccess);
  tally(toHand, "boards", boardOwners, boardAccess);
  return toHand;
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
