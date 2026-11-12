import type { MailboxId, UserId } from "@cloudysuite/access";
import {
  chunked,
  readSendingFacts as readAppSendingFacts,
} from "@cloudysuite/app-email";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  addresses,
  mailboxAccess,
  mailboxes,
  user,
} from "../../../../src/db/schema";
import type { EmailAddress, OutsideInviting } from "../types";

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
  const facts = await readAppSendingFacts(database, organiser, colleagues);
  return {
    calendarOff: facts.appsOff.has("calendar"),
    mailOff: facts.appsOff.has("mail"),
    organiser: (facts.sender?.address ?? null) as EmailAddress | null,
    colleagues: facts.colleagues as Map<UserId, EmailAddress>,
  };
}

// Whose own mailbox each address reaches, primary or alias. A personal mailbox's person is
// the manager given it first, as for their own address.
export async function colleaguesAt(
  database: D1Database,
  wanted: EmailAddress[],
): Promise<Map<EmailAddress, UserId>> {
  const db = drizzle(database);
  const [first, ...rest] = chunked(wanted).map((part) =>
    db
      .select({ address: addresses.address, userId: mailboxAccess.userId })
      .from(addresses)
      .innerJoin(mailboxes, eq(mailboxes.id, addresses.mailboxId))
      .innerJoin(mailboxAccess, eq(mailboxAccess.mailboxId, mailboxes.id))
      .where(
        and(
          inArray(addresses.address, part),
          eq(mailboxes.kind, "personal"),
          eq(mailboxAccess.role, "manager"),
        ),
      )
      .orderBy(asc(mailboxAccess.createdAt), asc(mailboxAccess.userId)),
  );
  const found = new Map<EmailAddress, UserId>();
  if (!first) return found;
  // Each address is in one part, so the order within it still decides.
  for (const row of (await db.batch([first, ...rest])).flat()) {
    const address = row.address as EmailAddress;
    if (!found.has(address)) found.set(address, row.userId);
  }
  return found;
}

// Whose own mailbox this is, by the same rule. A shared mailbox is no one person's. The
// name is the directory's, since an email can call them anything.
export async function personOfMailbox(
  database: D1Database,
  mailboxId: MailboxId,
): Promise<{ id: UserId; name: string } | null> {
  const [row] = await drizzle(database)
    .select({ id: user.id, name: user.name })
    .from(mailboxAccess)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
    .innerJoin(user, eq(user.id, mailboxAccess.userId))
    .where(
      and(
        eq(mailboxAccess.mailboxId, mailboxId),
        eq(mailboxes.kind, "personal"),
        eq(mailboxAccess.role, "manager"),
      ),
    )
    .orderBy(asc(mailboxAccess.createdAt), asc(mailboxAccess.userId))
    .limit(1);
  return row ?? null;
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
