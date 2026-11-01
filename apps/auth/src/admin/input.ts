import { parseMailboxId } from "@cloudysuite/access";
import type {
  MailboxId,
  MailboxRole,
  OrgRole,
  UserId,
} from "../../../../src/db/schema";
import { MAILBOX_ROLES, ORG_ROLES } from "../../../../src/db/schema";
import type { ToggleableApp } from "../../../../src/routing";
import { isToggleableApp } from "./organisation";

export function badInput(): Response {
  return new Response(
    JSON.stringify({ message: "That request isn't valid." }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    },
  );
}

export function readText(input: unknown, key: string): string {
  const value = (input as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== "string" || value.length > 1024) throw badInput();
  return value;
}

export function readFlag(input: unknown, key: string): boolean {
  const value = (input as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value !== "boolean") throw badInput();
  return value;
}

export const readUserId = (input: unknown): UserId =>
  readText(input, "userId") as UserId;

export function readMailboxId(input: unknown): MailboxId {
  const id = parseMailboxId(readText(input, "mailboxId"));
  if (!id) throw badInput();
  return id;
}

export function readOrgRole(input: unknown): OrgRole {
  const role = readText(input, "role") as OrgRole;
  if (!ORG_ROLES.includes(role)) throw badInput();
  return role;
}

export function readMailboxRole(input: unknown): MailboxRole {
  const role = readText(input, "role") as MailboxRole;
  if (!MAILBOX_ROLES.includes(role)) throw badInput();
  return role;
}

export function readToggleableApp(input: unknown): ToggleableApp {
  const app = readText(input, "app");
  if (!isToggleableApp(app)) throw badInput();
  return app;
}
