import { env } from "cloudflare:workers";
import type { DriveId, UserId } from "@cloudysuite/access";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, count, eq, inArray, sql, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { driveAccess, drives, orgSettings, user } from "../../../src/db/schema";
import { openDriveAs, openDriveToEdit, requireStorageUser } from "./access";
import { moveRefusal, readStorageRoom } from "./limits";
import { ensureMyDrive } from "./my-drive";
import { parseItemName } from "./names";
import {
  type DriveItem,
  type DriveSummary,
  type FileItem,
  type FolderItem,
  type FolderListing,
  FOLDER_BUSY,
  INTO_ITSELF,
  ITEM_BUSY,
  nameTakenMessage,
  NO_SUCH_FOLDER,
  NO_SUCH_ITEM,
  type Person,
  type RestoreResult,
  TOO_MANY_TO_MOVE,
  type TrashEntry,
} from "./types";
import {
  parseFileInput,
  parseFolderInput,
  parseItemInput,
  parseMoveInput,
  parseNewFolderInput,
  parseNewTeamFolderInput,
  parseRecentInput,
  parseRenameInput,
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
    return ensureMyDrive(me.id);
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
    const drive = await openDriveToEdit(me.id, data.driveId);
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
      case "folderBusy":
        throw refusal(409, FOLDER_BUSY);
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

export const renameItem = createServerFn({ method: "POST" })
  .validator(parseRenameInput)
  .handler(async ({ data }): Promise<DriveItem> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveToEdit(me.id, data.driveId);
    const parsed = parseItemName(data.name);
    if (!parsed.ok) throw refusal(400, parsed.message);
    const result = await drive.rename(data.itemId, parsed);
    switch (result.status) {
      case "renamed":
        return result.item;
      case "nameTaken":
        throw refusal(409, nameTakenMessage(parsed.name));
      case "gone":
        throw refusal(404, NO_SUCH_ITEM);
      case "busy":
        throw refusal(409, ITEM_BUSY);
    }
  });

// "finishing" is a move that started and will complete by itself.
export const moveItem = createServerFn({ method: "POST" })
  .validator(parseMoveInput)
  .handler(async ({ data }): Promise<"moved" | "finishing"> => {
    const me = await requireStorageUser(getRequest());
    const from = await openDriveToEdit(me.id, data.driveId);
    const to = await openDriveToEdit(me.id, data.toDriveId);
    const item = await from.item(data.itemId);
    if (!item) throw refusal(404, NO_SUCH_ITEM);
    const result = await from.move(data.itemId, to, data.toParentId);
    switch (result.status) {
      case "moved":
        return "moved";
      case "pending":
        return "finishing";
      case "nameTaken":
        throw refusal(409, nameTakenMessage(item.name));
      case "gone":
        throw refusal(404, NO_SUCH_ITEM);
      case "noDestination":
        throw refusal(404, NO_SUCH_FOLDER);
      case "intoItself":
        throw refusal(409, INTO_ITSELF);
      case "busy":
        throw refusal(409, ITEM_BUSY);
      case "folderBusy":
        throw refusal(409, FOLDER_BUSY);
      case "overLimit":
        throw refusal(
          413,
          moveRefusal(
            await readStorageRoom(env.DB, data.toDriveId),
            result.bytes,
          ),
        );
      case "tooMany":
        throw refusal(409, TOO_MANY_TO_MOVE);
    }
  });

export const trashItem = createServerFn({ method: "POST" })
  .validator(parseItemInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveToEdit(me.id, data.driveId);
    const result = await drive.trash(data.itemId);
    if (result.status === "gone") throw refusal(404, NO_SUCH_ITEM);
    if (result.status === "busy") throw refusal(409, ITEM_BUSY);
  });

async function drivesOf(me: UserId): Promise<DriveSummary[]> {
  return drizzle(env.DB)
    .select({
      id: drives.id,
      kind: drives.kind,
      name: drives.name,
      colour: drives.colour,
    })
    .from(driveAccess)
    .innerJoin(drives, eq(drives.id, driveAccess.driveId))
    .where(eq(driveAccess.userId, me));
}

export type TrashLine = { entry: TrashEntry; drive: DriveSummary };

const TRASH_SHOWN = 200;

// Trash is kept per drive and shown as one list, so this is the one page that wakes every
// drive a person can open.
export const getTrash = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ lines: TrashLine[]; more: boolean }> => {
    const me = await requireStorageUser(getRequest());
    const lists = await Promise.all(
      (await drivesOf(me.id)).map(async (drive) => {
        const client = await openDriveAs(me.id, drive.id);
        const entries = await client.trashEntries(TRASH_SHOWN + 1);
        return entries.map((entry) => ({ entry, drive }));
      }),
    );
    const lines = lists
      .flat()
      .sort((a, b) => b.entry.trashedAt - a.entry.trashedAt);
    return {
      lines: lines.slice(0, TRASH_SHOWN),
      more: lines.length > TRASH_SHOWN,
    };
  },
);

export const restoreItem = createServerFn({ method: "POST" })
  .validator(parseItemInput)
  .handler(
    async ({
      data,
    }): Promise<Extract<RestoreResult, { status: "restored" }>> => {
      const me = await requireStorageUser(getRequest());
      const drive = await openDriveToEdit(me.id, data.driveId);
      const result = await drive.restore(data.itemId);
      if (result.status === "gone") throw refusal(404, NO_SUCH_ITEM);
      if (result.status === "folderBusy") throw refusal(409, FOLDER_BUSY);
      return result;
    },
  );

export const deleteItemForever = createServerFn({ method: "POST" })
  .validator(parseItemInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveToEdit(me.id, data.driveId);
    await drive.deleteForever(data.itemId);
  });

export const emptyTrash = createServerFn({ method: "POST" }).handler(
  async (): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const results = await Promise.allSettled(
      (await drivesOf(me.id)).map(async ({ id }) => {
        const drive = await openDriveToEdit(me.id, id);
        await drive.emptyTrash();
      }),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw refusal(
        500,
        "Some of Trash couldn't be emptied. Choose Empty Trash again to finish.",
      );
    }
  },
);
