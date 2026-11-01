import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  addresses,
  mailboxAccess,
  type MailboxId,
  type MailboxKind,
  type MailboxRole,
  mailboxes,
  user,
  type UserId,
} from "../../../../src/db/schema";
import { type Outcome, refuse } from "../outcome";
import { checkNewAddress, readEmailDomains } from "./addresses";
import { createPersonalMailbox } from "./invites";

export type MailboxRow = {
  id: MailboxId;
  kind: MailboxKind;
  name: string;
  addresses: { address: string; kind: "primary" | "alias" }[];
  access: {
    userId: UserId;
    name: string;
    email: string;
    role: MailboxRole;
  }[];
};

export type MailboxesView = {
  mailboxes: MailboxRow[];
  people: { id: UserId; name: string; email: string }[];
  emailDomains: string[];
};

export async function listMailboxes(
  database: D1Database,
): Promise<MailboxesView> {
  const db = drizzle(database);
  const [rows, addressRows, accessRows, people] = await db.batch([
    db.select().from(mailboxes).orderBy(mailboxes.kind, mailboxes.name),
    db.select().from(addresses).orderBy(addresses.kind, addresses.address),
    db
      .select({
        mailboxId: mailboxAccess.mailboxId,
        userId: mailboxAccess.userId,
        role: mailboxAccess.role,
        name: user.name,
        email: user.email,
      })
      .from(mailboxAccess)
      .innerJoin(user, eq(user.id, mailboxAccess.userId))
      .orderBy(user.name),
    db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .orderBy(user.name),
  ]);
  return {
    mailboxes: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      addresses: addressRows
        .filter((address) => address.mailboxId === row.id)
        .map(({ address, kind }) => ({ address, kind })),
      access: accessRows
        .filter((access) => access.mailboxId === row.id)
        .map(({ userId, name, email, role }) => ({
          userId,
          name,
          email,
          role,
        })),
    })),
    people,
    emailDomains: await readEmailDomains(database),
  };
}

const ADDRESS_TAKEN = "That address was just taken. Choose a different one.";

export async function createSharedMailbox(
  database: D1Database,
  input: { name: string; address: string },
): Promise<Outcome> {
  const name = input.name.trim();
  if (!name) return refuse("Give the mailbox a name, such as Support.");
  const check = await checkNewAddress(database, input.address);
  if (!check.ok) return check;
  const db = drizzle(database);
  const mailboxId = crypto.randomUUID() as MailboxId;
  try {
    await db.batch([
      db.insert(mailboxes).values({ id: mailboxId, kind: "shared", name }),
      db.insert(addresses).values({
        address: check.parsed.address,
        domain: check.parsed.domain,
        mailboxId,
        kind: "primary",
      }),
    ]);
  } catch {
    return refuse(ADDRESS_TAKEN);
  }
  return { ok: true };
}

export async function addPersonalMailbox(
  database: D1Database,
  input: { userId: UserId; address: string },
): Promise<Outcome> {
  const db = drizzle(database);
  const [person] = await db
    .select({ name: user.name })
    .from(user)
    .where(eq(user.id, input.userId));
  if (!person) return refuse("That person no longer has an account.");
  const existing = await db
    .select({ id: mailboxes.id })
    .from(mailboxAccess)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
    .where(
      and(
        eq(mailboxAccess.userId, input.userId),
        eq(mailboxes.kind, "personal"),
      ),
    );
  if (existing.length > 0) {
    return refuse(
      `${person.name} already has a personal mailbox. Add an alias to it instead.`,
    );
  }
  const check = await checkNewAddress(database, input.address, input.userId);
  if (!check.ok) return check;
  try {
    await createPersonalMailbox(
      database,
      input.userId,
      person.name,
      check.parsed,
    );
  } catch {
    return refuse(ADDRESS_TAKEN);
  }
  return { ok: true };
}

export async function addAlias(
  database: D1Database,
  input: { mailboxId: MailboxId; address: string },
): Promise<Outcome> {
  const check = await checkNewAddress(database, input.address);
  if (!check.ok) return check;
  try {
    await drizzle(database).insert(addresses).values({
      address: check.parsed.address,
      domain: check.parsed.domain,
      mailboxId: input.mailboxId,
      kind: "alias",
    });
  } catch {
    return refuse(ADDRESS_TAKEN);
  }
  return { ok: true };
}

export async function removeAlias(
  database: D1Database,
  address: string,
): Promise<void> {
  await drizzle(database)
    .delete(addresses)
    .where(and(eq(addresses.address, address), eq(addresses.kind, "alias")));
}

export async function grantAccess(
  database: D1Database,
  input: { mailboxId: MailboxId; userId: UserId; role: MailboxRole },
): Promise<Outcome> {
  try {
    await drizzle(database)
      .insert(mailboxAccess)
      .values(input)
      .onConflictDoUpdate({
        target: [mailboxAccess.mailboxId, mailboxAccess.userId],
        set: { role: input.role },
      });
  } catch {
    return refuse("That person or mailbox no longer exists.");
  }
  return { ok: true };
}

export async function revokeAccess(
  database: D1Database,
  input: { mailboxId: MailboxId; userId: UserId },
): Promise<void> {
  await drizzle(database)
    .delete(mailboxAccess)
    .where(
      and(
        eq(mailboxAccess.mailboxId, input.mailboxId),
        eq(mailboxAccess.userId, input.userId),
      ),
    );
}
