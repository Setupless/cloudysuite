// Local only: writes a sign-in to the local D1 database with `--local`.
// Production accounts come from the setup wizard and invites.
import { hashPassword } from "better-auth/crypto";
import { $ } from "bun";

const [email, password, role = "admin"] = process.argv.slice(2);
if (!email || !password || !["admin", "user"].includes(role)) {
  console.error(
    "Usage: bun run db:seed:user:local <email> <password> [admin|user]",
  );
  process.exit(1);
}

const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const address = email.toLowerCase();
const id = crypto.randomUUID();
const accountId = crypto.randomUUID();
const now = Date.now();
const name = address.split("@")[0];
const hash = await hashPassword(password);

const sql = [
  `DELETE FROM user WHERE email = ${quote(address)}`,
  `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (${quote(id)}, ${quote(name)}, ${quote(address)}, 1, ${quote(role)}, ${now}, ${now})`,
  `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (${quote(accountId)}, ${quote(id)}, 'credential', ${quote(id)}, ${quote(hash)}, ${now}, ${now})`,
].join("; ");

await $`wrangler d1 execute DB --local --command ${sql}`.quiet();
console.log(`Seeded ${address} as ${role}.`);
