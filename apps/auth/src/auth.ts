import { passkey } from "@better-auth/passkey";
import { isBanned } from "@cloudysuite/access";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { admin, twoFactor } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../../src/db/schema";
import type { AppOrigins } from "./origins";
import { isEnrolled, type Removal, removalRefusal } from "./sign-in-methods";
import { readRequire2fa, readSignInMethods } from "./sign-in-methods-store";

// Admin actions run only through CloudySuite's server functions, which apply
// the organisation's 2FA rule and refuse changes to your own account.
const ADMIN_ROUTES = [
  "set-role",
  "get-user",
  "create-user",
  "update-user",
  "list-users",
  "list-user-sessions",
  "unban-user",
  "ban-user",
  "impersonate-user",
  "stop-impersonating",
  "revoke-user-session",
  "revoke-user-sessions",
  "remove-user",
  "set-user-password",
  "has-permission",
].map((route) => `/admin/${route}`);

const REMOVAL_ROUTES: Record<string, Removal> = {
  "/passkey/delete-passkey": "passkey",
  "/two-factor/disable": "authenticator",
};

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
    // Accounts come from invites, through auth.api.createUser on the server,
    // which this setting does not block, and from the setup wizard's first admin.
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: { cookieCache: { enabled: false } },
    // The default store is per isolate and the default switch reads NODE_ENV,
    // which Workers does not set, so sign-in would have no shared limit.
    rateLimit: { enabled: true, storage: "database" },
    telemetry: { enabled: false },
    disabledPaths: ADMIN_ROUTES,
    databaseHooks: {
      session: {
        create: {
          // A passkey counts as 2FA, but a stolen password must not reach the
          // account on its own. An authenticator user passes here and gets the
          // code step, and a person with neither is sent to enrol.
          before: async (session, context) => {
            if (context?.path !== "/sign-in/email") return;
            const methods = await readSignInMethods(
              database,
              session.userId as schema.UserId,
            );
            if (
              methods.passkeys > 0 &&
              !methods.authenticator &&
              (await readRequire2fa(database))
            ) {
              throw new APIError("FORBIDDEN", {
                code: "PASSKEY_REQUIRED",
                message:
                  "Your organisation asks you to sign in with a passkey.",
              });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        const removal = REMOVAL_ROUTES[context.path];
        if (!removal) return;
        const session = await getSessionFromCtx(context);
        if (!session) return;
        const refusal = removalRefusal(
          await readSignInMethods(database, session.user.id as schema.UserId),
          removal,
          await readRequire2fa(database),
        );
        if (refusal) {
          throw new APIError("FORBIDDEN", {
            code: "LAST_SIGN_IN_METHOD",
            message: refusal,
          });
        }
      }),
    },
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

// Better Auth checks a ban only when it creates a session, so a session from
// before the ban would otherwise stay valid.
export async function getActiveSession(
  auth: ReturnType<typeof createAuth>,
  headers: Headers,
) {
  const session = await auth.api.getSession({ headers });
  return session && !isBanned(session.user) ? session : null;
}

export type SessionUser = {
  id: schema.UserId;
  name: string;
  email: string;
  role: schema.OrgRole;
};

export type Viewer =
  | { status: "signed-out" }
  | { status: "must-enrol"; user: SessionUser }
  | { status: "ready"; user: SessionUser };

export async function readViewer(
  auth: ReturnType<typeof createAuth>,
  database: D1Database,
  headers: Headers,
): Promise<Viewer> {
  const session = await getActiveSession(auth, headers);
  if (!session) return { status: "signed-out" };
  const { id, name, email, role } = session.user;
  const user: SessionUser = {
    id: id as schema.UserId,
    name,
    email,
    role: role === "admin" ? "admin" : "user",
  };
  const blocked =
    (await readRequire2fa(database)) &&
    !isEnrolled(await readSignInMethods(database, user.id));
  return { status: blocked ? "must-enrol" : "ready", user };
}
