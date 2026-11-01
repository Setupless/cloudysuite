import { drizzle } from "drizzle-orm/d1";
import {
  account,
  addresses,
  domains,
  mailboxAccess,
  mailboxes,
  type MailboxId,
  type UserId,
  user,
} from "../../../../src/db/schema";
import { readSettings } from "../../../../src/settings";
import type { createAuth } from "../auth";
import type { DomainPlan, FirstAdminInput } from "./model";

// One atomic batch, so the unique primary-domain index picks one winner among
// parallel requests, and the others leave nothing behind. `auth.api.createUser`
// would commit the user first, so this writes the same rows itself, with Better
// Auth's own hasher, so sign-in can verify the password. Returns false when
// setup was already finished.
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
}): Promise<boolean> {
  const { password, generateId } = await auth.$context;
  const passwordHash = await password.hash(admin.password);

  const db = drizzle(database);
  const now = new Date();
  const userId = generateId({ model: "user" }) as UserId;
  const mailboxId = crypto.randomUUID() as MailboxId;
  const domainRows =
    plan.appDomain === plan.emailDomain
      ? [{ name: plan.appDomain, isPrimary: true }]
      : [
          { name: plan.emailDomain, isPrimary: false },
          { name: plan.appDomain, isPrimary: true },
        ];

  try {
    await db.batch([
      db.insert(domains).values(domainRows),
      db.insert(user).values({
        id: userId,
        name: admin.name,
        email: admin.email,
        role: "admin",
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(account).values({
        id: generateId({ model: "account" }) as string,
        accountId: userId,
        providerId: "credential",
        userId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      }),
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
    return true;
  } catch (error) {
    const { primaryDomain } = await readSettings(database);
    if (primaryDomain !== null) return false;
    throw error;
  }
}
