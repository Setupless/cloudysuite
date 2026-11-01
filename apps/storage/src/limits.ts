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
export function limitRefusal(
  room: StorageRoom,
  sizeBytes: number,
): string | null {
  const [tightest] = [
    {
      used: room.driveUsedBytes,
      limit: room.driveLimitBytes,
      name: (limit: string) => `your ${limit} limit for My files`,
    },
    {
      used: room.orgUsedBytes,
      limit: room.orgLimitBytes,
      name: (limit: string) => `your organisation's ${limit} limit`,
    },
  ]
    .flatMap(({ used, limit, name }) =>
      limit !== null && used + sizeBytes > limit
        ? [{ left: Math.max(0, limit - used), name: name(formatBytes(limit)) }]
        : [],
    )
    .sort((a, b) => a.left - b.left);
  if (!tightest) return null;
  const space =
    tightest.left === 0
      ? "there's no space left"
      : `only ${formatBytes(tightest.left)} is left`;
  return `This file is ${formatBytes(sizeBytes)}, and ${space} in ${tightest.name}. Ask your admin for more space.`;
}

// Another upload took the last of the space, then something was removed before this
// sentence was written, so there are no figures that would explain it.
export const NO_ROOM_NOW = `There wasn't enough space for this file when it finished. Choose it again to try once more. If it's refused again, ask your admin for more space.`;
