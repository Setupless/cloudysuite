import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { passkey } from "../../../../src/db/schema";
import { readViewer } from "../auth";
import { signedInOnly } from "../middleware";
import { parseReturnTo, safeReturnUrl, signInUrl } from "../origins";
import { getAuth } from "../server";
import type { SignInMethods } from "../sign-in-methods";
import { readRequire2fa, readSignInMethods } from "../sign-in-methods-store";

export type PasskeySummary = {
  id: string;
  name: string | null;
  addedAt: Date | null;
};

export type AccountView = {
  methods: SignInMethods;
  require2fa: boolean;
  passkeys: PasskeySummary[];
};

export const getAccount = createServerFn({ method: "GET" })
  .middleware([signedInOnly])
  .handler(async ({ context }): Promise<AccountView> => {
    const [methods, require2fa, passkeys] = await Promise.all([
      readSignInMethods(env.DB, context.user.id),
      readRequire2fa(env.DB),
      drizzle(env.DB)
        .select({
          id: passkey.id,
          name: passkey.name,
          addedAt: passkey.createdAt,
        })
        .from(passkey)
        .where(eq(passkey.userId, context.user.id))
        .orderBy(passkey.createdAt),
    ]);
    return { methods, require2fa, passkeys };
  });

export const prepareEnrol = createServerFn({ method: "GET" })
  .validator(parseReturnTo)
  .handler(async ({ data }): Promise<{ returnTo: string }> => {
    const request = getRequest();
    const { auth, origins } = await getAuth(request);
    const returnTo =
      (data.returnTo && safeReturnUrl(data.returnTo, origins)) ||
      `${origins.auth}/`;
    const viewer = await readViewer(auth, env.DB, request.headers);
    if (viewer.status === "signed-out") {
      throw redirect({ href: signInUrl(origins, returnTo) });
    }
    if (viewer.status === "ready") throw redirect({ href: returnTo });
    return { returnTo };
  });
