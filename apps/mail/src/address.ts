import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { addresses, type MailboxId } from "../../../src/db/schema";

// The exact address comes first, so a stored address that contains a plus, such
// as team+sales@example.com, still wins over its base address.
export function recipientCandidates(to: string): string[] {
  const address = to.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return [];
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  return plus > 0
    ? [address, `${local.slice(0, plus)}${address.slice(at)}`]
    : [address];
}

export async function resolveRecipient(
  database: D1Database,
  to: string,
): Promise<MailboxId | null> {
  const candidates = recipientCandidates(to);
  if (candidates.length === 0) return null;
  const rows = await drizzle(database)
    .select({ address: addresses.address, mailboxId: addresses.mailboxId })
    .from(addresses)
    .where(inArray(addresses.address, candidates));
  for (const candidate of candidates) {
    const row = rows.find((entry) => entry.address === candidate);
    if (row) return row.mailboxId;
  }
  return null;
}
