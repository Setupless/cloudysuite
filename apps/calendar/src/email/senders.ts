import { isBanned, type UserId } from "@cloudysuite/access";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  addresses,
  appSettings,
  mailboxAccess,
  mailboxes,
  user,
} from "../../../../src/db/schema";
import type { EmailAddress, OutsideInviting } from "../types";

// A person's own address is the primary address of the personal mailbox they manage.
// A shared mailbox belongs to no one person. Should someone also manage another
// person's personal mailbox, the one they were given first is their own.
function ownAddresses(db: ReturnType<typeof drizzle>, people: UserId[]) {
  return db
    .select({ userId: mailboxAccess.userId, address: addresses.address })
    .from(mailboxAccess)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
    .innerJoin(addresses, eq(addresses.mailboxId, mailboxes.id))
    .where(
      and(
        inArray(mailboxAccess.userId, people),
        eq(mailboxAccess.role, "manager"),
        eq(mailboxes.kind, "personal"),
        eq(addresses.kind, "primary"),
      ),
    )
    .orderBy(asc(mailboxAccess.createdAt), asc(mailboxes.id));
}

const firstOfEach = (rows: { userId: UserId; address: string }[]) => {
  const found = new Map<UserId, EmailAddress>();
  for (const row of rows) {
    if (!found.has(row.userId)) {
      found.set(row.userId, row.address as EmailAddress);
    }
  }
  return found;
};

// What an email needs from the directory, read again before each attempt, because
// minutes can pass before it goes.
export type SendingFacts = {
  calendarOff: boolean;
  mailOff: boolean;
  // Null when they have no personal mailbox, were removed, or are suspended.
  organiser: EmailAddress | null;
  // Each colleague's own address, for those who have one.
  colleagues: Map<UserId, EmailAddress>;
};

// Throws when the directory can't answer, and nothing may go then.
export async function readSendingFacts(
  database: D1Database,
  organiser: UserId,
  colleagues: UserId[],
): Promise<SendingFacts> {
  const db = drizzle(database);
  const [off, person, own] = await db.batch([
    db
      .select({ app: appSettings.app })
      .from(appSettings)
      .where(eq(appSettings.enabled, false)),
    db
      .select({ banned: user.banned, banExpires: user.banExpires })
      .from(user)
      .where(eq(user.id, organiser)),
    ownAddresses(db, [...new Set([organiser, ...colleagues])]),
  ]);
  const disabled = new Set(off.map((row) => row.app));
  const found = firstOfEach(own);
  const sender =
    person[0] && !isBanned(person[0]) ? found.get(organiser) : null;
  found.delete(organiser);
  return {
    calendarOff: disabled.has("calendar"),
    mailOff: disabled.has("mail"),
    organiser: sender ?? null,
    colleagues: new Map(
      colleagues.flatMap((userId) => {
        const address = found.get(userId);
        return address ? [[userId, address] as const] : [];
      }),
    ),
  };
}

// Whose own mailbox each address reaches, primary or alias. A personal mailbox's person is
// the manager given it first, as for their own address.
export async function colleaguesAt(
  database: D1Database,
  wanted: EmailAddress[],
): Promise<Map<EmailAddress, UserId>> {
  const db = drizzle(database);
  const rows = await db
    .select({ address: addresses.address, userId: mailboxAccess.userId })
    .from(addresses)
    .innerJoin(mailboxes, eq(mailboxes.id, addresses.mailboxId))
    .innerJoin(mailboxAccess, eq(mailboxAccess.mailboxId, mailboxes.id))
    .where(
      and(
        inArray(addresses.address, wanted),
        eq(mailboxes.kind, "personal"),
        eq(mailboxAccess.role, "manager"),
      ),
    )
    .orderBy(asc(mailboxAccess.createdAt), asc(mailboxAccess.userId));
  const found = new Map<EmailAddress, UserId>();
  for (const row of rows) {
    const address = row.address as EmailAddress;
    if (!found.has(address)) found.set(address, row.userId);
  }
  return found;
}

// For the event dialog, and for a change that adds an address.
export async function outsideInviting(
  database: D1Database,
  organiser: UserId,
): Promise<OutsideInviting> {
  const facts = await readSendingFacts(database, organiser, []);
  if (facts.mailOff) return "mailOff";
  return facts.organiser ? "ready" : "noSender";
}
