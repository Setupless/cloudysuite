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

// Null when the file fits. When it fits neither limit, this names the one with less left.
// D1 can't tell bytes that a move counts twice from a limit that is really full, so only
// a file bigger than a whole limit is told that trying again won't help.
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
        ? [
            {
              left: Math.max(0, limit - used),
              name: name(formatBytes(limit)),
              tooBig: sizeBytes > limit,
            },
          ]
        : [],
    )
    .sort((a, b) => a.left - b.left);
  const [tightest] = refusals;
  if (!tightest) return null;
  const next = refusals.some((refusal) => refusal.tooBig)
    ? "Ask your admin for more space."
    : "Try again in a minute, as space can take that long to free up after a move. If it's still refused, ask your admin for more space.";
  return `This file is ${formatBytes(sizeBytes)}, and ${spaceLeft(tightest.left)} in ${tightest.name}. ${next}`;
}

// Someone reaching another person's My files through a share didn't set this limit up
// for themselves, so "your" would send them looking in the wrong place.
const myFilesLimit = (limit: string, throughShare: boolean) =>
  throughShare
    ? `the ${limit} limit for the My files this is in`
    : `your ${limit} limit for My files`;

const spaceLeft = (bytes: number) =>
  bytes === 0 ? "there's no space left" : `only ${formatBytes(bytes)} is left`;

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
