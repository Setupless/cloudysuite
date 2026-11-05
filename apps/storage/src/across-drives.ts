import type { DriveId, UserId } from "@cloudysuite/access";
import { askEach } from "@cloudysuite/search";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  driveAccess,
  driveMoveNotices,
  driveShares,
  drives,
} from "../../../src/db/schema";
import type { DriveClient } from "./client";
import type { DriveSearch } from "./search-query";
import type { MoveNotice, SearchLine, StarredLine } from "./types";

const SEARCH_LINES_PER_DRIVE = 50;
const SEARCH_LINES_SHOWN = 100;
const STARRED_PER_DRIVE = 200;
const STARRED_SHOWN = 200;

// Null name for a drive this person isn't on, whose name they must not learn.
type DriveToAsk = { driveId: DriveId; name: string | null };

export type OpenDrive = (driveId: DriveId) => Promise<DriveClient>;

// The drives on this person's list, and any the share index points at. A share with
// everyone isn't in the index, so it brings no drive into a search.
async function drivesToAsk(
  database: D1Database,
  me: UserId,
): Promise<DriveToAsk[]> {
  const db = drizzle(database);
  const [mine, indexed] = await db.batch([
    db
      .select({ driveId: drives.id, name: drives.name })
      .from(driveAccess)
      .innerJoin(drives, eq(drives.id, driveAccess.driveId))
      .where(eq(driveAccess.userId, me)),
    db
      .selectDistinct({ driveId: driveShares.driveId })
      .from(driveShares)
      .where(eq(driveShares.userId, me)),
  ]);
  const onList = new Set(mine.map((row) => row.driveId));
  return [
    ...mine,
    ...indexed
      .filter((row) => !onList.has(row.driveId))
      .map((row) => ({ driveId: row.driveId, name: null })),
  ];
}

const askDrives = <Answer>(
  list: readonly DriveToAsk[],
  open: OpenDrive,
  ask: (drive: DriveClient, entry: DriveToAsk) => Promise<Answer>,
) => askEach(list, async (entry) => ask(await open(entry.driveId), entry));

export type SearchRow = SearchLine & {
  driveId: DriveId;
  // The drive's name, or null when this person reaches it only through a share.
  driveName: string | null;
};

export type SearchAnswer = {
  rows: SearchRow[];
  // Whether more matched than are shown.
  more: boolean;
  // Whether some drive couldn't answer.
  incomplete: boolean;
};

export async function searchDrives(
  database: D1Database,
  me: UserId,
  open: OpenDrive,
  search: DriveSearch,
): Promise<SearchAnswer> {
  const { answers, incomplete } = await askDrives(
    await drivesToAsk(database, me),
    open,
    async (drive, { driveId, name }) => {
      const found = await drive.search(search, SEARCH_LINES_PER_DRIVE);
      return {
        more: found.more,
        rows: found.lines.map((line): SearchRow => ({
          ...line,
          driveId,
          driveName: name,
        })),
      };
    },
  );
  const sorted = answers
    .flatMap((answer) => answer.rows)
    .sort((a, b) => b.item.changedAt - a.item.changedAt);
  return {
    rows: sorted.slice(0, SEARCH_LINES_SHOWN),
    more:
      answers.some((answer) => answer.more) ||
      sorted.length > SEARCH_LINES_SHOWN,
    incomplete,
  };
}

export type MoveNoticeRow = MoveNotice & { driveId: DriveId };

// Only the drives D1 says hold a note for this person, so a page with nothing to tell
// wakes no drive. A drive that can't answer just shows nothing this time.
export async function moveNoticesAcrossDrives(
  database: D1Database,
  me: UserId,
  open: OpenDrive,
): Promise<MoveNoticeRow[]> {
  const indexed = await drizzle(database)
    .selectDistinct({ driveId: driveMoveNotices.driveId })
    .from(driveMoveNotices)
    .where(eq(driveMoveNotices.userId, me));
  const { answers } = await askDrives(
    indexed.map(({ driveId }) => ({ driveId, name: null })),
    open,
    async (drive, { driveId }) =>
      (await drive.moveNotices()).map((notice): MoveNoticeRow => ({
        ...notice,
        driveId,
      })),
  );
  return answers.flat().sort((a, b) => b.notedAt - a.notedAt);
}

export type StarredRow = StarredLine & { driveId: DriveId };

export async function starredAcrossDrives(
  database: D1Database,
  me: UserId,
  open: OpenDrive,
): Promise<{ rows: StarredRow[]; incomplete: boolean }> {
  const { answers, incomplete } = await askDrives(
    await drivesToAsk(database, me),
    open,
    async (drive, { driveId }) =>
      (await drive.starred(STARRED_PER_DRIVE)).map((line): StarredRow => ({
        ...line,
        driveId,
      })),
  );
  return {
    rows: answers
      .flat()
      .sort((a, b) => b.starredAt - a.starredAt)
      .slice(0, STARRED_SHOWN),
    incomplete,
  };
}
