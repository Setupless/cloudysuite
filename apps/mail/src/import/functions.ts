import { env } from "cloudflare:workers";
import { requireReadyUser } from "@cloudysuite/auth/guard";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { mailboxAccess, mailboxes } from "../../../../src/db/schema";

export type ManagedMailbox = { id: string; name: string };

// Only lists choices for the screen. Each import call makes its own access check.
export const getManagedMailboxes = createServerFn({ method: "GET" }).handler(
  async (): Promise<ManagedMailbox[]> => {
    const user = await requireReadyUser(getRequest());
    return drizzle(env.DB)
      .select({ id: mailboxes.id, name: mailboxes.name })
      .from(mailboxAccess)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
      .where(
        and(
          eq(mailboxAccess.userId, user.id),
          eq(mailboxAccess.role, "manager"),
        ),
      )
      .orderBy(mailboxes.name);
  },
);
