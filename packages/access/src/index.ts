import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  mailboxAccess,
  type MailboxId,
  type MailboxRole,
  type UserId,
} from "../../../src/db/schema";

export type { MailboxId, MailboxRole, UserId };

declare const issuedByCheck: unique symbol;

// Mailbox code takes a grant rather than a mailbox id. The brand has no
// exported constructor, so only checkMailboxAccess can produce one, and code
// that skips the check does not compile.
export type MailboxGrant = {
  readonly userId: UserId;
  readonly mailboxId: MailboxId;
  readonly role: MailboxRole;
  readonly [issuedByCheck]: true;
};

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
  const grant = { userId, mailboxId, role: row.role } as MailboxGrant;
  return { allowed: true, grant };
}
