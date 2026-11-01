import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  account,
  passkey,
  session,
  twoFactor,
  user,
  type UserId,
  verification,
} from "../../../../src/db/schema";
import type { createAuth } from "../auth";
import { type Outcome, refuse } from "../outcome";
import { hashToken, newToken } from "../tokens";
import { passwordProblem } from "./invites";

const RESET_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;
const IDENTIFIER = "sign-in-reset:";

// Clears every way in at once, including the old password, so someone holding a
// stolen password or an old device is locked out until the link is used.
export async function issueResetLink(
  database: D1Database,
  userId: UserId,
  now = new Date(),
): Promise<string> {
  const db = drizzle(database);
  const token = newToken();
  const identifier = `${IDENTIFIER}${await hashToken(token)}`;
  await db.batch([
    db.delete(passkey).where(eq(passkey.userId, userId)),
    db.delete(twoFactor).where(eq(twoFactor.userId, userId)),
    db
      .delete(account)
      .where(
        and(eq(account.userId, userId), eq(account.providerId, "credential")),
      ),
    db.delete(session).where(eq(session.userId, userId)),
    db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, userId)),
    // Earlier reset links, and any half-finished sign-in waiting on a code.
    db.delete(verification).where(eq(verification.value, userId)),
    db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier,
      value: userId,
      expiresAt: new Date(now.getTime() + RESET_LIFETIME_MS),
    }),
  ]);
  return token;
}

export type ResetView = { valid: true; email: string } | { valid: false };

export async function readResetLink(
  database: D1Database,
  token: string,
  now = new Date(),
): Promise<ResetView> {
  const db = drizzle(database);
  const [row] = await db
    .select({ email: user.email })
    .from(verification)
    .innerJoin(user, eq(user.id, verification.value))
    .where(
      and(
        eq(verification.identifier, `${IDENTIFIER}${await hashToken(token)}`),
        gt(verification.expiresAt, now),
      ),
    );
  return row ? { valid: true, email: row.email } : { valid: false };
}

const LINK_FINISHED =
  "This link has already been used or has expired. Ask your admin for a new one.";

export async function completeReset(
  auth: ReturnType<typeof createAuth>,
  database: D1Database,
  input: { token: string; password: string },
  now = new Date(),
): Promise<Outcome<{ email: string }>> {
  const problem = passwordProblem(input.password);
  if (problem) return refuse(problem);

  const db = drizzle(database);
  const identifier = `${IDENTIFIER}${await hashToken(input.token)}`;
  // Nobody is signed in here, so a wrong token must not cost a password hash.
  const [current] = await db
    .select({ id: verification.id })
    .from(verification)
    .where(
      and(
        eq(verification.identifier, identifier),
        gt(verification.expiresAt, now),
      ),
    );
  if (!current) return refuse(LINK_FINISHED);

  const context = await auth.$context;
  const hashed = await context.password.hash(input.password);
  // The single atomic step, which still decides the winner when several
  // requests passed the check above. Only one concurrent request gets the row.
  const [claimed] = await db
    .delete(verification)
    .where(
      and(
        eq(verification.identifier, identifier),
        gt(verification.expiresAt, now),
      ),
    )
    .returning({ userId: verification.value });
  if (!claimed) return refuse(LINK_FINISHED);

  const [person] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, claimed.userId as UserId));
  if (!person) return refuse(LINK_FINISHED);

  await context.internalAdapter.linkAccount({
    providerId: "credential",
    accountId: claimed.userId,
    userId: claimed.userId,
    password: hashed,
  });
  return { ok: true, email: person.email };
}
