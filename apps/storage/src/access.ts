import { env } from "cloudflare:workers";
import {
  checkDriveAccess,
  type DriveId,
  type UserId,
} from "@cloudysuite/access";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { assertStorageOn } from "./app-on";
import { openDrive, openDriveToEdit as openToEdit } from "./client";

export const NO_ACCESS_MESSAGE =
  "You don't have access to this folder. Ask the person who created it if you need it.";

export async function requireStorageUser(request: Request) {
  await assertStorageOn(env.DB);
  return requireReadyUser(request);
}

const noAccess = () =>
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

// For one request that opens several drives after `requireStorageUser`.
export async function openDriveAs(userId: UserId, driveId: DriveId) {
  const access = await checkDriveAccess(env.DB, userId, driveId);
  if (!access.allowed) throw noAccess();
  return openDrive(env, access.grant);
}

// Every change a person makes to a drive opens it here.
export async function openDriveToEdit(userId: UserId, driveId: DriveId) {
  const drive = await openToEdit(env, userId, driveId);
  if (!drive) throw noAccess();
  return drive;
}

export async function openDriveToEditFor(request: Request, driveId: DriveId) {
  const user = await requireStorageUser(request);
  return openDriveToEdit(user.id, driveId);
}
