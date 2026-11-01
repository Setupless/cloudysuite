import { isBanned } from "@cloudysuite/access";
import { desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  addresses,
  invites,
  mailboxAccess,
  mailboxes,
  type OrgRole,
  passkey,
  user,
  type UserId,
  verification,
} from "../../../../src/db/schema";

export type PersonRow = {
  id: UserId;
  name: string;
  email: string;
  role: OrgRole;
  suspended: boolean;
  hasSecondWay: boolean;
  mailboxAddresses: string[];
};

export type InviteRow = {
  id: string;
  email: string;
  role: OrgRole;
  mailboxAddress: string | null;
  expired: boolean;
};

export async function listPeople(
  database: D1Database,
  now = new Date(),
): Promise<{ people: PersonRow[]; invites: InviteRow[] }> {
  const db = drizzle(database);
  const [people, keyOwners, personalAddresses, pending] = await db.batch([
    db.select().from(user).orderBy(user.name),
    db.selectDistinct({ userId: passkey.userId }).from(passkey),
    db
      .select({ userId: mailboxAccess.userId, address: addresses.address })
      .from(mailboxAccess)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
      .innerJoin(addresses, eq(addresses.mailboxId, mailboxes.id))
      .where(eq(mailboxes.kind, "personal")),
    db
      .select()
      .from(invites)
      .where(isNull(invites.usedAt))
      .orderBy(desc(invites.createdAt)),
  ]);
  const withKey = new Set(keyOwners.map((row) => row.userId));
  return {
    people: people.map((person) => ({
      id: person.id,
      name: person.name,
      email: person.email,
      role: person.role === "admin" ? "admin" : "user",
      suspended: isBanned(person),
      hasSecondWay: withKey.has(person.id) || Boolean(person.twoFactorEnabled),
      mailboxAddresses: personalAddresses
        .filter((row) => row.userId === person.id)
        .map((row) => row.address),
    })),
    invites: pending.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      mailboxAddress: invite.mailboxAddress,
      expired: invite.expiresAt <= now,
    })),
  };
}

export async function forgetResetLinks(
  database: D1Database,
  userId: UserId,
): Promise<void> {
  await drizzle(database)
    .delete(verification)
    .where(eq(verification.value, userId));
}
