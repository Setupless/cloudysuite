// Local only: writes a sign-in to the local D1 database with `--local`.
// Production accounts come from the setup wizard and invites.
import { hashPassword } from "better-auth/crypto";
import { $ } from "bun";

const [email, password, role = "admin"] = process.argv.slice(2);
// Better Auth refuses to sign in an address with no dot in its domain.
const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email ?? "");
if (!validEmail || !password || !["admin", "user"].includes(role)) {
  console.error(
    "Usage: bun run db:seed:user:local <email> <password> [admin|user]",
  );
  process.exit(1);
}

const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const address = email.toLowerCase();
const now = Date.now();
const name = address.split("@")[0];
const hash = await hashPassword(password);

const userId = `(SELECT id FROM user WHERE email = ${quote(address)})`;

// Seeding an existing address changes only its role and password, so its
// passkeys, two-factor data, and mailbox access stay in place.
const sql = [
  `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (${quote(crypto.randomUUID())}, ${quote(name)}, ${quote(address)}, 1, ${quote(role)}, ${now}, ${now}) ON CONFLICT (email) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
  `DELETE FROM account WHERE provider_id = 'credential' AND user_id = ${userId}`,
  `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT ${quote(crypto.randomUUID())}, id, 'credential', id, ${quote(hash)}, ${now}, ${now} FROM user WHERE email = ${quote(address)}`,
].join("; ");

await $`wrangler d1 execute DB --local --command ${sql}`.quiet();
console.log(`Seeded ${address} as ${role}.`);
