import { isAppId, type AppId } from "../../../src/routing";
import { badInput } from "./admin/input";

// A GET server function called without ?payload= reaches its validator as
// undefined, so nothing here may assume an object.
function readPath(input: unknown): string {
  const path = (input as { path?: unknown } | null | undefined)?.path;
  if (typeof path !== "string") throw badInput();
  return path;
}

export function parsePlace(input: unknown): { app: AppId; path: string } {
  const app = (input as { app?: unknown } | null | undefined)?.app;
  if (typeof app !== "string" || !isAppId(app)) throw badInput();
  return { app, path: readPath(input) };
}

export function parsePath(input: unknown): { path: string } {
  return { path: readPath(input) };
}
