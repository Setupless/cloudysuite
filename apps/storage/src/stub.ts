import type { DriveId } from "@cloudysuite/access";

// Not exported from the package. Only client.ts may import this, and
// boundaries.test.ts fails if anything else touches the binding.
export function driveStub(env: Env, driveId: DriveId) {
  return env.DRIVE.get(env.DRIVE.idFromName(driveId));
}
