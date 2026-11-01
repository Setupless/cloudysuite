import { env } from "cloudflare:workers";
import {
  type DriveId,
  ensurePersonalDrive,
  type UserId,
} from "@cloudysuite/access";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, count, eq, inArray, sql, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { driveAccess, drives, orgSettings, user } from "../../../src/db/schema";
import { openDriveAs, requireStorageUser } from "./access";
import { parseItemName } from "./names";
import {
  type DriveSummary,
  type FileItem,
  type FolderItem,
  type FolderListing,
  nameTakenMessage,
  NO_SUCH_FOLDER,
  type Person,
} from "./types";
import {
  parseFileInput,
  parseFolderInput,
  parseNewFolderInput,
  parseNewTeamFolderInput,
  parseRecentInput,
  refusal,
} from "./wire";

const TEAM_COLOURS = 6;
// D1 allows 100 bound values in a statement.
const PEOPLE_CHUNK = 90;
const MEMBERS_SHOWN = 3;

export type TeamFolderCard = DriveSummary & {
  fileCount: number;
  changedAt: number;
  members: Person[];
};

export type Directory = {
  myDriveId: DriveId | null;
  teamFolders: TeamFolderCard[];
  usedBytes: number;
  // Null means no limit, so the meter shows only the amount used.
  limitBytes: number | null;
  // Null until the person has a limit for My files.
  myFiles: { usedBytes: number; limitBytes: number } | null;
};

export type People = Record<string, Person>;

async function peopleOf(ids: Iterable<string>): Promise<People> {
  const db = drizzle(env.DB);
  const unique = [...new Set(ids)] as UserId[];
  const people: People = {};
  for (let start = 0; start < unique.length; start += PEOPLE_CHUNK) {
    const rows = await db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, unique.slice(start, start + PEOPLE_CHUNK)));
    for (const row of rows) people[row.id] = row;
  }
  return people;
}

// Reads D1 only, so Home and the sidebar wake no Durable Object.
export const getDirectory = createServerFn({ method: "GET" }).handler(
  async (): Promise<Directory> => {
    const me = await requireStorageUser(getRequest());
    const db = drizzle(env.DB);
    const fellow = sql`${driveAccess.driveId} IN (SELECT drive_id FROM drive_access WHERE user_id = ${me.id})`;
    const [mine, members, totals, settings] = await db.batch([
      db
        .select({
          id: drives.id,
          kind: drives.kind,
          name: drives.name,
          colour: drives.colour,
          fileCount: drives.fileCount,
          changedAt: drives.changedAt,
          usedBytes: drives.usedBytes,
          limitBytes: drives.limitBytes,
        })
        .from(driveAccess)
        .innerJoin(drives, eq(drives.id, driveAccess.driveId))
        .where(eq(driveAccess.userId, me.id))
        .orderBy(asc(drives.name)),
      db
        .select({
          driveId: driveAccess.driveId,
          id: user.id,
          name: user.name,
          email: user.email,
        })
        .from(driveAccess)
        .innerJoin(user, eq(user.id, driveAccess.userId))
        .where(fellow)
        .orderBy(asc(driveAccess.createdAt)),
      db.select({ usedBytes: sum(drives.usedBytes) }).from(drives),
      db
        .select({ limitBytes: orgSettings.storageLimitBytes })
        .from(orgSettings),
    ]);

    const my = mine.find((row) => row.kind === "personal");
    return {
      myDriveId: my?.id ?? null,
      teamFolders: mine
        .filter((row) => row.kind === "team")
        .map(({ usedBytes: _used, limitBytes: _limit, ...row }) => ({
          ...row,
          changedAt: row.changedAt.getTime(),
          members: members
            .filter((member) => member.driveId === row.id)
            .slice(0, MEMBERS_SHOWN)
            .map(({ id, name, email }) => ({ id, name, email })),
        })),
      usedBytes: Number(totals[0]?.usedBytes ?? 0),
      limitBytes: settings[0]?.limitBytes ?? null,
      myFiles:
        my && my.limitBytes !== null
          ? { usedBytes: my.usedBytes, limitBytes: my.limitBytes }
          : null,
    };
  },
);

export const ensureMyFiles = createServerFn({ method: "POST" }).handler(
  async (): Promise<DriveId> => {
    const me = await requireStorageUser(getRequest());
    const db = drizzle(env.DB);
    const owned = and(eq(drives.ownerId, me.id), eq(drives.kind, "personal"));
    const [, , found] = await db.batch([
      ...ensurePersonalDrive(db, me.id),
      db.select({ id: drives.id }).from(drives).where(owned),
    ]);
    const id = found[0]?.id;
    if (!id) throw new Error("A personal drive should exist by now.");
    return id;
  },
);

export const createTeamFolder = createServerFn({ method: "POST" })
  .validator(parseNewTeamFolderInput)
  .handler(async ({ data }): Promise<DriveId> => {
    const me = await requireStorageUser(getRequest());
    const parsed = parseItemName(data.name);
    if (!parsed.ok) throw refusal(400, parsed.message);
    const db = drizzle(env.DB);
    const [existing] = await db
      .select({ total: count() })
      .from(drives)
      .where(eq(drives.kind, "team"));
    const id = crypto.randomUUID() as DriveId;
    await db.batch([
      db.insert(drives).values({
        id,
        kind: "team",
        name: parsed.name,
        colour: ((existing?.total ?? 0) % TEAM_COLOURS) + 1,
      }),
      db
        .insert(driveAccess)
        .values({ driveId: id, userId: me.id, role: "manager" }),
    ]);
    return id;
  });

export type FolderPage = FolderListing & {
  drive: DriveSummary & { changedAt: number };
  // Who made the drive, for the panel's "Created by" at its root.
  driveCreatedBy: UserId | null;
  people: People;
};

export const getFolder = createServerFn({ method: "GET" })
  .validator(parseFolderInput)
  .handler(async ({ data }): Promise<FolderPage> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const listing = await drive.list(data.folderId, data.cursor);
    if (!listing) throw refusal(404, NO_SUCH_FOLDER);

    const db = drizzle(env.DB);
    const [[row], managers] = await db.batch([
      db
        .select({
          id: drives.id,
          kind: drives.kind,
          name: drives.name,
          colour: drives.colour,
          changedAt: drives.changedAt,
        })
        .from(drives)
        .where(eq(drives.id, data.driveId)),
      db
        .select({ userId: driveAccess.userId })
        .from(driveAccess)
        .where(
          and(
            eq(driveAccess.driveId, data.driveId),
            eq(driveAccess.role, "manager"),
          ),
        )
        .orderBy(asc(driveAccess.createdAt))
        .limit(1),
    ]);
    if (!row) throw refusal(404, NO_SUCH_FOLDER);
    const driveCreatedBy = managers[0]?.userId ?? null;
    return {
      ...listing,
      drive: { ...row, changedAt: row.changedAt.getTime() },
      driveCreatedBy,
      people: await peopleOf([
        ...listing.items.map((item) => item.createdBy),
        ...(listing.folder ? [listing.folder.createdBy] : []),
        ...(driveCreatedBy ? [driveCreatedBy] : []),
      ]),
    };
  });

export const getFile = createServerFn({ method: "GET" })
  .validator(parseFileInput)
  .handler(async ({ data }) => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const file = await drive.file(data.fileId);
    return file ? { file, people: await peopleOf([file.createdBy]) } : null;
  });

export const createFolder = createServerFn({ method: "POST" })
  .validator(parseNewFolderInput)
  .handler(async ({ data }): Promise<FolderItem> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const parsed = parseItemName(data.name);
    if (!parsed.ok) throw refusal(400, parsed.message);
    const result = await drive.createFolder(data.parentId, parsed);
    switch (result.status) {
      case "created":
        return result.item;
      case "nameTaken":
        throw refusal(409, nameTakenMessage(parsed.name));
      case "noParent":
        throw refusal(404, NO_SUCH_FOLDER);
    }
  });

export type RecentFile = { file: FileItem; drive: DriveSummary };

// The one read on Home that wakes objects, and only those of drives holding files.
export const getRecent = createServerFn({ method: "GET" })
  .validator(parseRecentInput)
  .handler(
    async ({ data }): Promise<{ files: RecentFile[]; people: People }> => {
      const me = await requireStorageUser(getRequest());
      const rows = await drizzle(env.DB)
        .select({
          id: drives.id,
          kind: drives.kind,
          name: drives.name,
          colour: drives.colour,
        })
        .from(driveAccess)
        .innerJoin(drives, eq(drives.id, driveAccess.driveId))
        .where(
          and(eq(driveAccess.userId, me.id), sql`${drives.fileCount} > 0`),
        );
      const lists = await Promise.all(
        rows.map(async (drive) => {
          const client = await openDriveAs(me.id, drive.id);
          const files = await client.recent(data.limit);
          return files.map((file) => ({ file, drive }));
        }),
      );
      const files = lists
        .flat()
        .sort((a, b) => b.file.changedAt - a.file.changedAt)
        .slice(0, data.limit);
      return {
        files,
        people: await peopleOf(files.map(({ file }) => file.createdBy)),
      };
    },
  );
