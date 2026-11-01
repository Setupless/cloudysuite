import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { OrgRole, UserId } from "../../../src/db/schema";
import { type AppId, isAppId } from "../../../src/routing";
import { safeReturnUrl, signInUrl } from "./origins";
import { getAuth } from "./server";

export type SessionUser = {
  id: UserId;
  name: string;
  email: string;
  role: OrgRole;
};

const requireUserOnServer = createServerFn({ method: "GET" })
  .validator((input: { app: string; path: string }) => {
    if (!isAppId(input.app)) throw new Error("Unknown app.");
    return { app: input.app, path: input.path };
  })
  .handler(async ({ data }): Promise<SessionUser> => {
    const request = getRequest();
    const { auth, origins } = await getAuth(request);
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      const here = new URL(data.path, origins[data.app]).href;
      throw redirect({ href: signInUrl(origins, here) });
    }
    const { id, name, email, role } = session.user;
    return {
      id: id as UserId,
      name,
      email,
      role: role === "admin" ? "admin" : "user",
    };
  });

export function requireUser(
  app: AppId,
  location: { publicHref: string },
): Promise<SessionUser> {
  return requireUserOnServer({ data: { app, path: location.publicHref } });
}

export const prepareSignIn = createServerFn({ method: "GET" })
  .validator((input: { returnTo?: string }) => input)
  .handler(async ({ data }): Promise<{ returnTo: string }> => {
    const request = getRequest();
    const { auth, origins } = await getAuth(request);
    const returnTo =
      (data.returnTo && safeReturnUrl(data.returnTo, origins)) ||
      `${origins.auth}/`;
    const session = await auth.api.getSession({ headers: request.headers });
    if (session) throw redirect({ href: returnTo });
    return { returnTo };
  });
