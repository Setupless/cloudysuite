import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  addresses,
  domains,
  mailboxAccess,
  mailboxes,
  type MailboxId,
  type UserId,
  user,
} from "../../../../src/db/schema";
import type { createAuth } from "../auth";
import type { DomainPlan, FirstAdminInput } from "./model";

// The domain rows go in the same atomic batch as the admin's mailbox, and the
// router opens the apps only once a primary domain exists. So until this batch
// commits, nobody can sign in and the wizard stays open, and any user or
// mailbox here came from an earlier attempt that stopped partway. That attempt
// may have used another address, so remove it and start clean. The condition
// repeats the check inside the delete, so a second, racing request cannot
// remove what a finished setup just stored.
export async function createFirstAdmin({
  database,
  auth,
  plan,
  admin,
}: {
  database: D1Database;
  auth: ReturnType<typeof createAuth>;
  plan: DomainPlan;
  admin: FirstAdminInput;
}): Promise<void> {
  const db = drizzle(database);
  const unfinished = sql`not exists (select 1 from ${domains} where ${domains.isPrimary} = 1)`;
  await db.batch([
    db.delete(user).where(unfinished),
    db.delete(mailboxes).where(unfinished),
  ]);

  const { user: created } = await auth.api.createUser({
    body: {
      email: admin.email,
      password: admin.password,
      name: admin.name,
      role: "admin",
    },
  });
  const userId = created.id as UserId;
  const mailboxId = crypto.randomUUID() as MailboxId;

  const domainRows =
    plan.appDomain === plan.emailDomain
      ? [{ name: plan.appDomain, isPrimary: true }]
      : [
          { name: plan.emailDomain, isPrimary: false },
          { name: plan.appDomain, isPrimary: true },
        ];

  await db.batch([
    db.insert(domains).values(domainRows),
    db
      .insert(mailboxes)
      .values({ id: mailboxId, kind: "personal", name: admin.name }),
    db.insert(addresses).values({
      address: `${admin.mailboxLocalPart}@${plan.emailDomain}`,
      domain: plan.emailDomain,
      mailboxId,
      kind: "primary",
    }),
    db.insert(mailboxAccess).values({ mailboxId, userId, role: "manager" }),
  ]);
}
