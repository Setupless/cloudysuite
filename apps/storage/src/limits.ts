import type { DriveId } from "@cloudysuite/access";
import { formatBytes } from "@cloudysuite/transfer";
import { eq, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { drives, orgSettings } from "../../../src/db/schema";

// From D1, so a figure can be a moment behind the Drive objects. It's right for telling
// a person early and for wording a refusal. Only `claimDriveSpace` decides a commit.
export type StorageRoom = {
  driveUsedBytes: number;
  driveLimitBytes: number | null;
  orgUsedBytes: number;
  orgLimitBytes: number | null;
};

export async function readStorageRoom(
  database: D1Database,
  driveId: DriveId,
): Promise<StorageRoom> {
  const db = drizzle(database);
  const [drive, total, settings] = await db.batch([
    db
      .select({ usedBytes: drives.usedBytes, limitBytes: drives.limitBytes })
      .from(drives)
      .where(eq(drives.id, driveId)),
    db.select({ usedBytes: sum(drives.usedBytes) }).from(drives),
    db.select({ limitBytes: orgSettings.storageLimitBytes }).from(orgSettings),
  ]);
  return {
    driveUsedBytes: drive[0]?.usedBytes ?? 0,
    driveLimitBytes: drive[0]?.limitBytes ?? null,
    orgUsedBytes: Number(total[0]?.usedBytes ?? 0),
    orgLimitBytes: settings[0]?.limitBytes ?? null,
  };
}

export const hasLimit = (room: StorageRoom) =>
  room.driveLimitBytes !== null || room.orgLimitBytes !== null;

// Null when the file fits. A file bigger than a whole limit is told which limits it can
// never fit, since freeing space can't help. Otherwise D1 can't tell bytes that a move
// counts twice from a limit that is really full, so the refusal names the limit with less
// left and says to try again.
export function limitRefusal(
  room: StorageRoom,
  sizeBytes: number,
  throughShare = false,
): string | null {
  const refusals = [
    {
      used: room.driveUsedBytes,
      limit: room.driveLimitBytes,
      name: (limit: string) => myFilesLimit(limit, throughShare),
    },
    {
      used: room.orgUsedBytes,
      limit: room.orgLimitBytes,
      name: (limit: string) => `your organisation's ${limit} limit`,
    },
  ]
    .flatMap(({ used, limit, name }) =>
      limit !== null && used + sizeBytes > limit
        ? [{ limit, left: Math.max(0, limit - used), name }]
        : [],
    )
    .sort((a, b) => a.left - b.left);
  const tooSmall = refusals.filter(({ limit }) => sizeBytes > limit);
  if (tooSmall.length > 0) {
    const show = distinctFigures(
      sizeBytes,
      ...tooSmall.map(({ limit }) => limit),
    );
    const limits = tooSmall
      .map(({ limit, name }) => name(show(limit)))
      .join(" and ");
    return `This file is ${show(sizeBytes)}, which is bigger than the whole of ${limits}. Ask your admin for more space.`;
  }
  const [tightest] = refusals;
  if (!tightest) return null;
  const show = distinctFigures(sizeBytes, tightest.left);
  return `This file is ${show(sizeBytes)}, and ${spaceLeft(tightest.left, show)} in ${tightest.name(formatBytes(tightest.limit))}. Try again in a minute, as space can take that long to free up after a move. If it's still refused, ask your admin for more space.`;
}

// A rounded file size that matches the figure it was compared with hides why it was
// refused, so those figures are given exactly.
const distinctFigures = (sizeBytes: number, ...others: number[]) =>
  others.some((other) => formatBytes(other) === formatBytes(sizeBytes))
    ? exactBytes
    : formatBytes;

const exactBytes = (bytes: number) =>
  `${bytes.toLocaleString("en-US")} ${bytes === 1 ? "byte" : "bytes"}`;

// Someone reaching another person's My files through a share didn't set this limit up
// for themselves, so "your" would send them looking in the wrong place.
const myFilesLimit = (limit: string, throughShare: boolean) =>
  throughShare
    ? `the ${limit} limit for the My files this is in`
    : `your ${limit} limit for My files`;

const spaceLeft = (bytes: number, show = formatBytes) =>
  bytes === 0 ? "there's no space left" : `only ${show(bytes)} is left`;

// A move adds nothing to the organisation's total, so only a limit for My files can
// refuse it, and that's the only drive with one.
export function moveRefusal(
  room: StorageRoom,
  sizeBytes: number,
  throughShare = false,
): string {
  const limit = room.driveLimitBytes;
  if (limit === null || room.driveUsedBytes + sizeBytes <= limit) {
    return "There wasn't enough space in My files for this just now. Try again. If it's refused again, delete something there or ask your admin for more space.";
  }
  return `This is ${formatBytes(sizeBytes)}, and ${spaceLeft(Math.max(0, limit - room.driveUsedBytes))} in ${myFilesLimit(formatBytes(limit), throughShare)}. Delete something there or ask your admin for more space.`;
}

// Another upload took the last of the space, then something was removed before this
// sentence was written, so there are no figures that would explain it.
export const NO_ROOM_NOW = `There wasn't enough space for this file when it finished. Wait a minute, then choose it again. If it's still refused, ask your admin for more space.`;
