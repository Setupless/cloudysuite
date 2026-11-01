import type { DriveId } from "@cloudysuite/access";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { drives, orgSettings } from "../../../src/db/schema";
import type { Usage } from "./store";

// Absolute values, so writing the same usage twice changes nothing.
export async function writeDriveUsage(
  database: D1Database,
  usage: Usage,
): Promise<void> {
  await drizzle(database)
    .update(drives)
    .set({
      usedBytes: usage.usedBytes,
      fileCount: usage.fileCount,
      changedAt: new Date(usage.changedAt),
    })
    .where(eq(drives.id, usage.driveId));
}

// A total is the drive's own truth. While one of its moves is in doubt that truth may not
// match D1, so only the bytes being added are named, and D1's figure stands.
export type NextUsage = { total: number } | { added: number };

// One statement, so D1 settles a race between two drives: whichever runs second sees the
// first one's bytes in the sum. It writes before the file exists, so D1 is never behind
// on bytes being added. False means a limit refused, and nothing changed.
export async function claimDriveSpace(
  database: D1Database,
  driveId: DriveId,
  next: NextUsage,
): Promise<boolean> {
  const after =
    "total" in next
      ? sql`${next.total}`
      : sql`${drives.usedBytes} + ${next.added}`;
  const orgLimit = sql`(SELECT ${orgSettings.storageLimitBytes} FROM ${orgSettings})`;
  const others = sql`(SELECT coalesce(sum(others.used_bytes), 0) FROM drives AS others WHERE others.id != ${driveId})`;
  const claimed = await drizzle(database)
    .update(drives)
    .set({ usedBytes: after })
    .where(
      and(
        eq(drives.id, driveId),
        sql`(${drives.limitBytes} IS NULL OR ${after} <= ${drives.limitBytes})`,
        sql`(${orgLimit} IS NULL OR ${others} + ${after} <= ${orgLimit})`,
      ),
    )
    .returning({ id: drives.id });
  return claimed.length > 0;
}

// One statement that carries the bytes across, so the organisation's total never counts
// them twice and needs no check. Only the receiving drive's own limit can refuse. The
// sender's figure is corrected to an exact total when it removes its rows, so a repeat
// after a crash is put right there.
export async function claimMoveSpace(
  database: D1Database,
  move: { fromDriveId: DriveId; toDriveId: DriveId; bytes: number },
  next: NextUsage,
): Promise<boolean> {
  const { fromDriveId, toDriveId, bytes } = move;
  const after =
    "total" in next
      ? sql`${next.total}`
      : sql`(SELECT receiver.used_bytes FROM drives AS receiver WHERE receiver.id = ${toDriveId}) + ${next.added}`;
  const limit = sql`(SELECT receiver.limit_bytes FROM drives AS receiver WHERE receiver.id = ${toDriveId})`;
  const claimed = await drizzle(database)
    .update(drives)
    .set({
      usedBytes: sql`CASE WHEN ${drives.id} = ${toDriveId} THEN ${after} ELSE max(${drives.usedBytes} - ${bytes}, 0) END`,
    })
    .where(
      and(
        inArray(drives.id, [fromDriveId, toDriveId]),
        sql`(${limit} IS NULL OR ${after} <= ${limit})`,
      ),
    )
    .returning({ id: drives.id });
  return claimed.some((row) => row.id === toDriveId);
}
