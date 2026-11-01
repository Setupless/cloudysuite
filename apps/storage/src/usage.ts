import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { drives } from "../../../src/db/schema";
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
