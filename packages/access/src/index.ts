import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  mailboxAccess,
  type MailboxId,
  type MailboxRole,
  user,
  type UserId,
} from "../../../src/db/schema";

export type { MailboxId, MailboxRole, UserId };

const ISSUE = Symbol();

// Mailbox code takes a grant rather than a mailbox id. The private field makes
// the type nominal, so code that skips the check, or copies a grant to change
// its values, does not compile. The constructor is reachable at runtime through
// grant.constructor, so it refuses any caller without this module's token. A
// type cast can still pass off a lookalike object as a grant.
class Grant {
  readonly #issuedByCheck = true;

  constructor(
    token: symbol,
    readonly userId: UserId,
    readonly mailboxId: MailboxId,
    readonly role: MailboxRole,
  ) {
    if (token !== ISSUE)
      throw new Error("Only the access check issues grants.");
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

// Matches Better Auth's admin plugin: a ban with no end date never expires, and
// one that has passed no longer blocks, though the row stays set until sign-in.
export function isBanned(person: {
  banned?: boolean | null;
  banExpires?: Date | null;
}): boolean {
  if (!person.banned) return false;
  return !person.banExpires || person.banExpires.getTime() >= Date.now();
}

export async function checkMailboxAccess(
  database: D1Database,
  userId: UserId,
  mailboxId: MailboxId,
): Promise<MailboxAccess> {
  const [row] = await drizzle(database)
    .select({
      role: mailboxAccess.role,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(mailboxAccess)
    .innerJoin(user, eq(user.id, mailboxAccess.userId))
    .where(
      and(
        eq(mailboxAccess.userId, userId),
        eq(mailboxAccess.mailboxId, mailboxId),
      ),
    );
  if (!row || isBanned(row)) return { allowed: false };
  return {
    allowed: true,
    grant: new Grant(ISSUE, userId, mailboxId, row.role),
  };
}
