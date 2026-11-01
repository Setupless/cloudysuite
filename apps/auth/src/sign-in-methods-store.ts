import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  account,
  orgSettings,
  passkey,
  user,
  type UserId,
} from "../../../src/db/schema";
import type { SignInMethods } from "./sign-in-methods";

export async function readRequire2fa(database: D1Database): Promise<boolean> {
  const [row] = await drizzle(database)
    .select({ require2fa: orgSettings.require2fa })
    .from(orgSettings);
  return row?.require2fa ?? false;
}

export async function readSignInMethods(
  database: D1Database,
  userId: UserId,
): Promise<SignInMethods> {
  const db = drizzle(database);
  const [[keys], [credential], [person]] = await db.batch([
    db
      .select({ total: count() })
      .from(passkey)
      .where(eq(passkey.userId, userId)),
    db
      .select({ password: account.password })
      .from(account)
      .where(
        and(eq(account.userId, userId), eq(account.providerId, "credential")),
      ),
    db
      .select({ authenticator: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, userId)),
  ]);
  return {
    passkeys: keys?.total ?? 0,
    password: Boolean(credential?.password),
    authenticator: person?.authenticator ?? false,
  };
}
