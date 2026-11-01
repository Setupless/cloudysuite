import { isBanned } from "@cloudysuite/access";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  addresses,
  drives,
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
  // Null until the person has a My files.
  myFiles: { usedBytes: number; limitBytes: number | null } | null;
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
  const [people, keyOwners, personalAddresses, pending, myFiles] =
    await db.batch([
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
      db
        .select({
          ownerId: drives.ownerId,
          usedBytes: drives.usedBytes,
          limitBytes: drives.limitBytes,
        })
        .from(drives)
        .where(and(eq(drives.kind, "personal"), isNotNull(drives.ownerId))),
    ]);
  const withKey = new Set(keyOwners.map((row) => row.userId));
  return {
    people: people.map((person) => {
      const drive = myFiles.find((row) => row.ownerId === person.id);
      return {
        id: person.id,
        name: person.name,
        email: person.email,
        role: person.role === "admin" ? "admin" : "user",
        suspended: isBanned(person),
        hasSecondWay:
          withKey.has(person.id) || Boolean(person.twoFactorEnabled),
        mailboxAddresses: personalAddresses
          .filter((row) => row.userId === person.id)
          .map((row) => row.address),
        myFiles: drive
          ? { usedBytes: drive.usedBytes, limitBytes: drive.limitBytes }
          : null,
      };
    }),
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
