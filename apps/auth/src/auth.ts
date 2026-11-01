import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, twoFactor } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../../src/db/schema";
import type { AppOrigins } from "./origins";

export function createAuth({
  database,
  secret,
  primaryDomain,
  origins,
}: {
  database: D1Database;
  secret: string;
  primaryDomain: string;
  origins: AppOrigins;
}) {
  return betterAuth({
    appName: "CloudySuite",
    baseURL: origins.auth,
    secret,
    trustedOrigins: Object.values(origins),
    database: drizzleAdapter(drizzle(database), {
      provider: "sqlite",
      schema,
    }),
    // Accounts come from the setup wizard and invites, through
    // auth.api.createUser on the server, which this setting does not block.
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { cookieCache: { enabled: false } },
    // The default store is per isolate and the default switch reads NODE_ENV,
    // which Workers does not set, so sign-in would have no shared limit.
    rateLimit: { enabled: true, storage: "database" },
    telemetry: { enabled: false },
    advanced: {
      crossSubDomainCookies: { enabled: true, domain: primaryDomain },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    plugins: [
      admin(),
      twoFactor({ issuer: "CloudySuite" }),
      passkey({
        rpID: primaryDomain,
        rpName: "CloudySuite",
        origin: origins.auth,
      }),
      tanstackStartCookies(),
    ],
  });
}
