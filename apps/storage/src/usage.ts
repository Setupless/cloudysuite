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
  usedBytes: number,
): Promise<boolean> {
  const orgLimit = sql`(SELECT ${orgSettings.storageLimitBytes} FROM ${orgSettings})`;
  const others = sql`(SELECT coalesce(sum(others.used_bytes), 0) FROM drives AS others WHERE others.id != ${driveId})`;
  const claimed = await drizzle(database)
    .update(drives)
    .set({ usedBytes })
    .where(
      and(
        eq(drives.id, driveId),
        sql`(${drives.limitBytes} IS NULL OR ${usedBytes} <= ${drives.limitBytes})`,
        sql`(${orgLimit} IS NULL OR ${others} + ${usedBytes} <= ${orgLimit})`,
      ),
    )
    .returning({ id: drives.id });
  return claimed.length > 0;
}
