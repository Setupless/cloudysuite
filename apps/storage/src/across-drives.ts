import type { DriveId, UserId } from "@cloudysuite/access";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { driveAccess, driveShares, drives } from "../../../src/db/schema";
import type { DriveClient } from "./client";
import type { SearchLine, StarredLine } from "./types";

// Workers allows six open connections at once, and the rest of the request needs some.
const DRIVES_AT_ONCE = 5;
const SEARCH_LINES_PER_DRIVE = 50;
const SEARCH_LINES_SHOWN = 100;
const STARRED_PER_DRIVE = 200;
const STARRED_SHOWN = 200;
// Long enough for a Drive object that has to wake first, short enough that one stuck drive
// can't leave the page waiting with no results.
const DRIVE_DEADLINE_MS = 5_000;

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

// One drive failing or answering too late doesn't fail the rest. Being refused isn't a
// failure: it means this person has no access any more, so there is nothing of theirs to show.
async function askEach<Line>(
  list: readonly DriveToAsk[],
  open: OpenDrive,
  ask: (drive: DriveClient, entry: DriveToAsk) => Promise<Line[]>,
): Promise<{ lines: Line[]; incomplete: boolean }> {
  const lines: Line[] = [];
  let incomplete = false;
  let next = 0;
  const worker = async () => {
    for (let entry = list[next++]; entry; entry = list[next++]) {
      try {
        lines.push(
          ...(await withinDeadline(
            open(entry.driveId).then((drive) => ask(drive, entry)),
          )),
        );
      } catch (thrown) {
        if (thrown instanceof Response && thrown.status === 403) continue;
        console.error("Could not read one drive.", thrown);
        incomplete = true;
      }
    }
  };
  await Promise.all(Array.from({ length: DRIVES_AT_ONCE }, worker));
  return { lines, incomplete };
}

async function withinDeadline<Value>(work: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("The drive didn't answer in time.")),
      DRIVE_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

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
  text: string,
): Promise<SearchAnswer> {
  let more = false;
  const { lines, incomplete } = await askEach(
    await drivesToAsk(database, me),
    open,
    async (drive, { driveId, name }) => {
      const found = await drive.search(text, SEARCH_LINES_PER_DRIVE);
      more ||= found.more;
      return found.lines.map((line): SearchRow => ({
        ...line,
        driveId,
        driveName: name,
      }));
    },
  );
  const sorted = lines.sort((a, b) => b.item.changedAt - a.item.changedAt);
  return {
    rows: sorted.slice(0, SEARCH_LINES_SHOWN),
    more: more || sorted.length > SEARCH_LINES_SHOWN,
    incomplete,
  };
}

export type StarredRow = StarredLine & { driveId: DriveId };

export async function starredAcrossDrives(
  database: D1Database,
  me: UserId,
  open: OpenDrive,
): Promise<{ rows: StarredRow[]; incomplete: boolean }> {
  const { lines, incomplete } = await askEach(
    await drivesToAsk(database, me),
    open,
    async (drive, { driveId }) =>
      (await drive.starred(STARRED_PER_DRIVE)).map((line): StarredRow => ({
        ...line,
        driveId,
      })),
  );
  return {
    rows: lines
      .sort((a, b) => b.starredAt - a.starredAt)
      .slice(0, STARRED_SHOWN),
    incomplete,
  };
}
