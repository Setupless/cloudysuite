import { isBanned, type UserId } from "@cloudysuite/access";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  addresses,
  appSettings,
  domains,
  mailboxAccess,
  mailboxes,
  user,
} from "../../../src/db/schema";
import { chunked } from "./chunked";

// A person's own address is the primary address of the personal mailbox they manage.
// A shared mailbox belongs to no one person. Should someone also manage another
// person's personal mailbox, the one they were given first is their own.
const ownAddresses = (db: ReturnType<typeof drizzle>, people: UserId[]) =>
  chunked(people).map((part) =>
    db
      .select({ userId: mailboxAccess.userId, address: addresses.address })
      .from(mailboxAccess)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
      .innerJoin(addresses, eq(addresses.mailboxId, mailboxes.id))
      .where(
        and(
          inArray(mailboxAccess.userId, part),
          eq(mailboxAccess.role, "manager"),
          eq(mailboxes.kind, "personal"),
          eq(addresses.kind, "primary"),
        ),
      )
      .orderBy(asc(mailboxAccess.createdAt), asc(mailboxes.id)),
  );

const firstOfEach = (rows: { userId: UserId; address: string }[]) => {
  const found = new Map<UserId, string>();
  for (const row of rows) {
    if (!found.has(row.userId)) found.set(row.userId, row.address);
  }
  return found;
};

// What an app's own email needs from the directory, read again before each attempt,
// because minutes can pass before it goes.
export type SendingFacts = {
  appsOff: ReadonlySet<string>;
  // Read from stored settings, never from a request's Host header.
  appDomain: string | null;
  // Null when they have no personal mailbox, were removed, or are suspended.
  sender: { address: string; name: string } | null;
  // Each colleague's own address, for those who have one.
  colleagues: Map<UserId, string>;
};

// Throws when the directory can't answer, and nothing may go then.
export async function readSendingFacts(
  database: D1Database,
  sender: UserId,
  colleagues: UserId[],
): Promise<SendingFacts> {
  const db = drizzle(database);
  const [off, primary, person, ...own] = await db.batch([
    db
      .select({ app: appSettings.app })
      .from(appSettings)
      .where(eq(appSettings.enabled, false)),
    db
      .select({ name: domains.name })
      .from(domains)
      .where(eq(domains.isPrimary, true)),
    db
      .select({
        name: user.name,
        banned: user.banned,
        banExpires: user.banExpires,
      })
      .from(user)
      .where(eq(user.id, sender)),
    ...ownAddresses(db, [sender, ...colleagues]),
  ]);
  // Each person is in one part, so the order within it still decides.
  const found = firstOfEach(own.flat());
  const address = person[0] && !isBanned(person[0]) && found.get(sender);
  found.delete(sender);
  return {
    appsOff: new Set(off.map((row) => row.app)),
    appDomain: primary[0]?.name ?? null,
    sender: address ? { address, name: person[0]!.name } : null,
    colleagues: new Map(
      colleagues.flatMap((userId) => {
        const own = found.get(userId);
        return own ? [[userId, own] as const] : [];
      }),
    ),
  };
}
