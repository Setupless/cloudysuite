import type { DriveId, UserId } from "@cloudysuite/access";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  driveAccess,
  driveMoveNotices,
  driveShares,
  drives,
} from "../../../src/db/schema";
import type { DriveClient } from "./client";
import type { MoveNotice, SearchLine, StarredLine } from "./types";

// Workers allows six open connections at once, and the rest of the request needs some.
const DRIVES_AT_ONCE = 5;
const SEARCH_LINES_PER_DRIVE = 50;
const SEARCH_LINES_SHOWN = 100;
const STARRED_PER_DRIVE = 200;
const STARRED_SHOWN = 200;
// Long enough for a Drive object that has to wake first, short enough that stuck drives
// can't leave the page waiting with no results. It covers asking all of them, not each one.
const DRIVES_DEADLINE_MS = 5_000;

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

// Being refused means this person has no access any more, so there is nothing of theirs to
// show. A drive that fails, answers after the deadline, or isn't reached by then is missing.
type Outcome<Answer> = { answer: Answer } | "refused" | "missing";

async function askEach<Answer>(
  list: readonly DriveToAsk[],
  open: OpenDrive,
  ask: (drive: DriveClient, entry: DriveToAsk) => Promise<Answer>,
): Promise<{ answers: Answer[]; incomplete: boolean }> {
  const outcomes: Outcome<Answer>[] = list.map(() => "missing");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), DRIVES_DEADLINE_MS);
  });
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < list.length; index = next++) {
      const entry = list[index]!;
      try {
        const outcome = await Promise.race([
          open(entry.driveId)
            .then((drive) => ask(drive, entry))
            .then((answer) => ({ answer })),
          late,
        ]);
        if (outcome === "late") return;
        outcomes[index] = outcome;
      } catch (thrown) {
        if (thrown instanceof Response && thrown.status === 403) {
          outcomes[index] = "refused";
        } else {
          console.error("Could not read one drive.", thrown);
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: DRIVES_AT_ONCE }, worker));
  } finally {
    clearTimeout(timer);
  }
  const missing = outcomes.filter((outcome) => outcome === "missing").length;
  if (missing > 0) {
    console.error(`Answered without ${missing} of ${list.length} drives.`);
  }
  return {
    answers: outcomes.flatMap((outcome) =>
      typeof outcome === "object" ? [outcome.answer] : [],
    ),
    incomplete: missing > 0,
  };
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
  const { answers, incomplete } = await askEach(
    await drivesToAsk(database, me),
    open,
    async (drive, { driveId, name }) => {
      const found = await drive.search(text, SEARCH_LINES_PER_DRIVE);
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
  const { answers } = await askEach(
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
  const { answers, incomplete } = await askEach(
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
