import { env } from "cloudflare:workers";
import { type DriveId, type UserId } from "@cloudysuite/access";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { assertAppOn } from "../../../src/app-on";
import { openDriveAsPerson } from "./client";

export const NO_ACCESS_MESSAGE =
  "You don't have access to this folder. Ask the person who created it if you need it.";

export async function requireStorageUser(request: Request) {
  await assertAppOn(env.DB, "storage");
  return requireReadyUser(request);
}

export const noAccess = () =>
  new Response(JSON.stringify({ message: NO_ACCESS_MESSAGE }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });

// Every request a person makes to a drive starts here: Storage being on, the sign-in
// rule, then the access check, in the call that uses the grant.
export async function openDriveFor(request: Request, driveId: DriveId) {
  const user = await requireStorageUser(request);
  return openDriveAs(user.id, driveId);
}

// For one request that opens several drives after `requireStorageUser`. Changes go through
// the same door: the object refuses a write from anyone without Can edit on that item.
export async function openDriveAs(userId: UserId, driveId: DriveId) {
  const drive = await openDriveAsPerson(env, userId, driveId);
  if (!drive) throw noAccess();
  return drive;
}
