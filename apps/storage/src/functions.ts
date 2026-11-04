import { env } from "cloudflare:workers";
import {
  type DriveId,
  type DriveRole,
  levelOfRole,
  type UserId,
} from "@cloudysuite/access";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, count, eq, sql, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { driveAccess, drives, orgSettings, user } from "../../../src/db/schema";
import { noAccess, openDriveAs, requireStorageUser } from "./access";
import { type MoveNoticeRow, moveNoticesAcrossDrives } from "./across-drives";
import type { DriveClient } from "./client";
import { moveRefusal, readStorageRoom } from "./limits";
import { ensureMyDrive } from "./my-drive";
import { parseItemName } from "./names";
import { type People, peopleOf } from "./people-lookup";
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
  RENAME_NEEDS_FOLDER,
  type RestoreResult,
  TOO_MANY_TO_MOVE,
  type TrashEntry,
} from "./types";
import {
  parseFileInput,
  parseFolderInput,
  parseItemInput,
  parseMoveInput,
  parseMoveNoticeInput,
  parseNewFolderInput,
  parseNewTeamFolderInput,
  parseRecentInput,
  parseRenameInput,
  refusal,
} from "./wire";

const TEAM_COLOURS = 6;
const MEMBERS_SHOWN = 3;

export type TeamFolderCard = DriveSummary & {
  fileCount: number;
  changedAt: number;
  members: Person[];
  role: DriveRole;
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

export type { People };

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
          role: driveAccess.role,
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

// A person reaching a folder through a share learns nothing about the drive around it.
export type FolderPlace =
  | {
      kind: "drive";
      drive: DriveSummary & { changedAt: number };
      // Who made the drive, for the panel's "Created by" at its root.
      driveCreatedBy: UserId | null;
      role: DriveRole;
    }
  | { kind: "shared" };

export type FolderPage = FolderListing & { place: FolderPlace; people: People };

// Someone not on the drive gets one answer for anything out of their reach, whether it
// exists or not.
const gone = (drive: DriveClient, message: string) =>
  drive.role === null ? noAccess() : refusal(404, message);

export const getFolder = createServerFn({ method: "GET" })
  .validator(parseFolderInput)
  .handler(async ({ data }): Promise<FolderPage> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const db = drizzle(env.DB);
    const member =
      drive.role === null
        ? null
        : {
            role: drive.role,
            details: db.batch([
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
            ]),
          };
    // Marks a failure as handled, so the listing's error still wins and this one surfaces
    // where it's awaited.
    member?.details.catch(() => {});
    const listing = await drive.list(data.folderId, data.cursor);
    if (!listing) throw gone(drive, NO_SUCH_FOLDER);
    const itemPeople = [
      ...listing.items.map((item) => item.createdBy),
      ...(listing.folder ? [listing.folder.createdBy] : []),
    ];
    if (!member) {
      return {
        ...listing,
        place: { kind: "shared" },
        people: await peopleOf(env.DB, itemPeople),
      };
    }

    const [[row], managers] = await member.details;
    if (!row) throw refusal(404, NO_SUCH_FOLDER);
    const driveCreatedBy = managers[0]?.userId ?? null;
    return {
      ...listing,
      place: {
        kind: "drive",
        drive: { ...row, changedAt: row.changedAt.getTime() },
        driveCreatedBy,
        role: member.role,
      },
      people: await peopleOf(env.DB, [
        ...itemPeople,
        ...(driveCreatedBy ? [driveCreatedBy] : []),
      ]),
    };
  });

export const getFile = createServerFn({ method: "GET" })
  .validator(parseFileInput)
  .handler(async ({ data }) => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const opened = await drive.opened(data.fileId);
    if (opened?.item.kind !== "file") return null;
    const file: FileItem = opened.item;
    return {
      file,
      canEdit: opened.canEdit,
      canRename: opened.canRename,
      shared: opened.shared,
      people: await peopleOf(env.DB, [file.createdBy]),
    };
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
      case "noAccess":
        throw noAccess();
      case "nameTaken":
        throw refusal(409, nameTakenMessage(parsed.name));
      case "noParent":
        throw refusal(404, NO_SUCH_FOLDER);
      case "folderBusy":
        throw refusal(409, FOLDER_BUSY);
    }
  });

export type RecentFile = {
  file: FileItem;
  drive: DriveSummary & { role: DriveRole };
};

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
          role: driveAccess.role,
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
        people: await peopleOf(
          env.DB,
          files.map(({ file }) => file.createdBy),
        ),
      };
    },
  );

export const renameItem = createServerFn({ method: "POST" })
  .validator(parseRenameInput)
  .handler(async ({ data }): Promise<DriveItem> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const parsed = parseItemName(data.name);
    if (!parsed.ok) throw refusal(400, parsed.message);
    const result = await drive.rename(data.itemId, parsed);
    switch (result.status) {
      case "renamed":
        return result.item;
      case "noAccess":
        throw noAccess();
      case "nameTaken":
        throw refusal(409, nameTakenMessage(parsed.name));
      case "folderOutOfReach":
        throw refusal(403, RENAME_NEEDS_FOLDER);
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
    const opening = openDriveAs(me.id, data.toDriveId);
    // Marks a failure as handled, so the first drive's error still wins and this one
    // surfaces where it's awaited.
    opening.catch(() => {});
    const from = await openDriveAs(me.id, data.driveId);
    const to = await opening;
    const item = await from.item(data.itemId);
    if (!item) throw gone(from, NO_SUCH_ITEM);
    const result = await from.move(data.itemId, to, data.toParentId);
    switch (result.status) {
      case "moved":
        return "moved";
      case "noAccess":
        throw noAccess();
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
            to.role === null,
          ),
        );
      case "tooMany":
        throw refusal(409, TOO_MANY_TO_MOVE);
    }
  });

export const getMoveNotices = createServerFn({ method: "GET" }).handler(
  async (): Promise<MoveNoticeRow[]> => {
    const me = await requireStorageUser(getRequest());
    return moveNoticesAcrossDrives(env.DB, me.id, (driveId) =>
      openDriveAs(me.id, driveId),
    );
  },
);

export const dismissMoveNotice = createServerFn({ method: "POST" })
  .validator(parseMoveNoticeInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    await drive.dismissMoveNotice(data.moveId);
  });

export const trashItem = createServerFn({ method: "POST" })
  .validator(parseItemInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const result = await drive.trash(data.itemId);
    if (result.status === "noAccess") throw noAccess();
    if (result.status === "gone") throw refusal(404, NO_SUCH_ITEM);
    if (result.status === "busy") throw refusal(409, ITEM_BUSY);
  });

// Can view doesn't reach Trash, so this is the drives a person can change.
async function drivesToChange(me: UserId): Promise<DriveSummary[]> {
  const rows = await drizzle(env.DB)
    .select({
      id: drives.id,
      kind: drives.kind,
      name: drives.name,
      colour: drives.colour,
      role: driveAccess.role,
    })
    .from(driveAccess)
    .innerJoin(drives, eq(drives.id, driveAccess.driveId))
    .where(eq(driveAccess.userId, me));
  return rows
    .filter(({ role }) => levelOfRole(role) === "edit")
    .map(({ role: _role, ...drive }) => drive);
}

export type TrashLine = { entry: TrashEntry; drive: DriveSummary };

const TRASH_SHOWN = 200;

// Trash is kept per drive and shown as one list, so this is the one page that wakes every
// drive a person can open.
export const getTrash = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ lines: TrashLine[]; more: boolean }> => {
    const me = await requireStorageUser(getRequest());
    const lists = await Promise.all(
      (await drivesToChange(me.id)).map(async (drive) => {
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
      const drive = await openDriveAs(me.id, data.driveId);
      const result = await drive.restore(data.itemId);
      if (result.status === "noAccess") throw noAccess();
      if (result.status === "gone") throw refusal(404, NO_SUCH_ITEM);
      if (result.status === "folderBusy") throw refusal(409, FOLDER_BUSY);
      return result;
    },
  );

export const deleteItemForever = createServerFn({ method: "POST" })
  .validator(parseItemInput)
  .handler(async ({ data }): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const drive = await openDriveAs(me.id, data.driveId);
    const refused = await drive.deleteForever(data.itemId);
    if (refused) throw noAccess();
  });

export const emptyTrash = createServerFn({ method: "POST" }).handler(
  async (): Promise<void> => {
    const me = await requireStorageUser(getRequest());
    const results = await Promise.allSettled(
      (await drivesToChange(me.id)).map(async ({ id }) => {
        const drive = await openDriveAs(me.id, id);
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
