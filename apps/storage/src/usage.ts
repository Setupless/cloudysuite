import type { DriveId } from "@cloudysuite/access";
import { and, eq, sql } from "drizzle-orm";
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

// One statement, so D1 settles a race between two drives: whichever runs second sees the
// first one's bytes in the sum. It writes before the file exists, so D1 is never behind
// on bytes being added. False means a limit refused, and nothing changed.
export async function claimDriveSpace(
  database: D1Database,
  driveId: DriveId,
  total: number,
): Promise<boolean> {
  const orgLimit = sql`(SELECT ${orgSettings.storageLimitBytes} FROM ${orgSettings})`;
  const others = sql`(SELECT coalesce(sum(others.used_bytes), 0) FROM drives AS others WHERE others.id != ${driveId})`;
  const claimed = await drizzle(database)
    .update(drives)
    .set({ usedBytes: total })
    .where(
      and(
        eq(drives.id, driveId),
        sql`(${drives.limitBytes} IS NULL OR ${total} <= ${drives.limitBytes})`,
        sql`(${orgLimit} IS NULL OR ${others} + ${total} <= ${orgLimit})`,
      ),
    )
    .returning({ id: drives.id });
  return claimed.length > 0;
}

// Moving doesn't grow the organisation, so only the receiver's own limit can refuse. The
// sender still counts these bytes until it has removed its rows, so D1 may count them on
// both sides for a while, and is never behind.
export async function claimMoveSpace(
  database: D1Database,
  driveId: DriveId,
  total: number,
): Promise<boolean> {
  const claimed = await drizzle(database)
    .update(drives)
    .set({ usedBytes: total })
    .where(
      and(
        eq(drives.id, driveId),
        sql`(${drives.limitBytes} IS NULL OR ${total} <= ${drives.limitBytes})`,
      ),
    )
    .returning({ id: drives.id });
  return claimed.length > 0;
}
