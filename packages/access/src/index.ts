import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  mailboxAccess,
  type MailboxId,
  type MailboxRole,
  type UserId,
} from "../../../src/db/schema";

export type { MailboxId, MailboxRole, UserId };

// Mailbox code takes a grant rather than a mailbox id. The class is not
// exported and its private field makes the type nominal, so only
// checkMailboxAccess can produce one. Code that skips the check, or copies a
// grant to change its values, does not compile.
class Grant {
  readonly #issuedByCheck = true;

  constructor(
    readonly userId: UserId,
    readonly mailboxId: MailboxId,
    readonly role: MailboxRole,
  ) {
    Object.freeze(this);
  }
}

export type MailboxGrant = Grant;

export type MailboxAccess =
  { allowed: true; grant: MailboxGrant } | { allowed: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseMailboxId(raw: string): MailboxId | null {
  return UUID.test(raw) ? (raw as MailboxId) : null;
}

export async function checkMailboxAccess(
  database: D1Database,
  userId: UserId,
  mailboxId: MailboxId,
): Promise<MailboxAccess> {
  const [row] = await drizzle(database)
    .select({ role: mailboxAccess.role })
    .from(mailboxAccess)
    .where(
      and(
        eq(mailboxAccess.userId, userId),
        eq(mailboxAccess.mailboxId, mailboxId),
      ),
    );
  if (!row) return { allowed: false };
  return { allowed: true, grant: new Grant(userId, mailboxId, row.role) };
}
