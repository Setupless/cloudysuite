import { env } from "cloudflare:workers";
import {
  type DriveId,
  ensurePersonalDrive,
  type UserId,
} from "@cloudysuite/access";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { drives } from "../../../src/db/schema";

export async function ensureMyDrive(userId: UserId): Promise<DriveId> {
  const db = drizzle(env.DB);
  const owned = and(eq(drives.ownerId, userId), eq(drives.kind, "personal"));
  const [, , found] = await db.batch([
    ...ensurePersonalDrive(db, userId),
    db.select({ id: drives.id }).from(drives).where(owned),
  ]);
  const id = found[0]?.id;
  if (!id) throw new Error("A personal drive should exist by now.");
  return id;
}
