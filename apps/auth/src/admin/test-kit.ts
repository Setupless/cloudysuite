import type { Database } from "bun:sqlite";
import { createTestDatabase } from "../../../../src/db/test-database";
import type { UserId } from "../../../../src/db/schema";
import { createAuth } from "../auth";
import { appOrigins } from "../origins";

export const AUTH_ORIGIN = "https://auth.example.com";
export const PASSWORD = "a long enough password";

export type Kit = {
  sqlite: Database;
  database: D1Database;
  auth: ReturnType<typeof createAuth>;
  admin: UserId;
  count: (table: string) => number;
  rows: (sql: string) => unknown[];
};

export async function createKit(): Promise<Kit> {
  const { sqlite, d1 } = createTestDatabase();
  sqlite.run(
    "INSERT INTO domains (name, is_primary) VALUES ('example.com', 1)",
  );
  const auth = createAuth({
    database: d1,
    secret: "test-secret-test-secret-test-secret-0123",
    primaryDomain: "example.com",
    origins: appOrigins("example.com", new Request(`${AUTH_ORIGIN}/`)),
  });
  const { user } = await auth.api.createUser({
    body: {
      email: "boss@example.com",
      password: PASSWORD,
      name: "Boss",
      role: "admin",
    },
  });
  return {
    sqlite,
    database: d1,
    auth,
    admin: user.id as UserId,
    count: (table) =>
      (
        sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
    rows: (sql) => sqlite.query(sql).all(),
  };
}

export function signIn(kit: Kit, email: string, password = PASSWORD) {
  return kit.auth.handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      body: JSON.stringify({ email, password }),
    }),
  );
}

// Nobody is signed in on the reset and invite links, so a wrong guess there must
// not cost a password hash.
export async function countHashes(kit: Kit, run: () => Promise<unknown>) {
  const { password } = await kit.auth.$context;
  const hash = password.hash;
  let calls = 0;
  password.hash = (value) => {
    calls += 1;
    return hash(value);
  };
  try {
    await run();
  } finally {
    password.hash = hash;
  }
  return calls;
}
