import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  addresses,
  domains,
  invites,
  user,
  type UserId,
} from "../../../../src/db/schema";

// An app domain such as suite.example.com is only for app addresses when its
// parent, the domain people's email uses, is stored too. With no stored parent,
// the same domain does both jobs. See "Email domains" in the README.
export function emailDomainNames(
  rows: readonly { name: string; isPrimary: boolean }[],
): string[] {
  const isAppOnly = ({ name, isPrimary }: (typeof rows)[number]) =>
    isPrimary && rows.some((other) => name.endsWith(`.${other.name}`));
  return rows
    .filter((row) => !isAppOnly(row))
    .sort(
      (a, b) =>
        Number(b.isPrimary) - Number(a.isPrimary) ||
        a.name.localeCompare(b.name),
    )
    .map((row) => row.name);
}

export async function readDomainRows(database: D1Database) {
  return drizzle(database).select().from(domains);
}

export async function readEmailDomains(database: D1Database) {
  return emailDomainNames(await readDomainRows(database));
}

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

export type ParsedAddress = { address: string; domain: string };

// Inbound mail resolves by exact match, so stored addresses are always lowercase.
export function parseAddress(raw: string): ParsedAddress | null {
  const address = raw.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 1) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!LOCAL_PART.test(local) || local.includes("..") || !domain) return null;
  return { address, domain };
}

export type AddressCheck =
  { ok: true; parsed: ParsedAddress } | { ok: false; message: string };

// `owner` may take the address they already sign in with. For anyone else it is
// taken, because mail to it would reach a different person from its sign-in.
export async function checkNewAddress(
  database: D1Database,
  raw: string,
  owner?: UserId,
  now = new Date(),
): Promise<AddressCheck> {
  const parsed = parseAddress(raw);
  if (!parsed) {
    return {
      ok: false,
      message:
        "That address isn't valid. Use letters, numbers, dots, dashes, and plus signs, such as maya@example.com.",
    };
  }
  const db = drizzle(database);
  const [domainNames, stored, reserved, person] = await Promise.all([
    readEmailDomains(database),
    db
      .select({ address: addresses.address })
      .from(addresses)
      .where(eq(addresses.address, parsed.address)),
    db
      .select({ id: invites.id })
      .from(invites)
      .where(
        and(
          eq(invites.mailboxAddress, parsed.address),
          isNull(invites.usedAt),
          gt(invites.expiresAt, now),
        ),
      ),
    db.select({ id: user.id }).from(user).where(eq(user.email, parsed.address)),
  ]);
  if (!domainNames.includes(parsed.domain)) {
    return {
      ok: false,
      message: `${parsed.domain} isn't one of your email domains. Add it under Email domains first.`,
    };
  }
  const signsInElsewhere = person.some(({ id }) => id !== owner);
  if (stored.length > 0 || reserved.length > 0 || signsInElsewhere) {
    return {
      ok: false,
      message: `${parsed.address} is already taken. Choose a different address.`,
    };
  }
  return { ok: true, parsed };
}
