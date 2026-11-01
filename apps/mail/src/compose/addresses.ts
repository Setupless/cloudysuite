import type { MailboxId } from "@cloudysuite/access";
import { asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { addresses, mailboxes } from "../../../../src/db/schema";

export type SenderFacts = {
  name: string;
  // The primary address comes first, and it is the default From.
  addresses: { address: string; kind: "primary" | "alias" }[];
};

export async function mailboxSenderFacts(
  database: D1Database,
  mailboxId: MailboxId,
): Promise<SenderFacts> {
  const db = drizzle(database);
  const [names, rows] = await db.batch([
    db
      .select({ name: mailboxes.name })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId)),
    db
      .select({ address: addresses.address, kind: addresses.kind })
      .from(addresses)
      .where(eq(addresses.mailboxId, mailboxId))
      .orderBy(desc(addresses.kind), asc(addresses.address)),
  ]);
  return { name: names[0]?.name ?? "", addresses: rows };
}

export const ownsAddress = (facts: SenderFacts, from: string) => {
  const wanted = from.trim().toLowerCase();
  return facts.addresses.some(({ address }) => address === wanted);
};

export const NOT_YOUR_ADDRESS =
  "You can't send from that address, because it doesn't belong to this mailbox. Choose another From address.";

// Throws the refusal, so that no path can reach a send without facing it.
export async function refuseSenderOutsideMailbox(
  database: D1Database,
  mailboxId: MailboxId,
  from: string,
): Promise<SenderFacts> {
  const facts = await mailboxSenderFacts(database, mailboxId);
  if (!ownsAddress(facts, from)) {
    throw new Response(JSON.stringify({ message: NOT_YOUR_ADDRESS }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return facts;
}
