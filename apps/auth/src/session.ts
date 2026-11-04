import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { APPS, type AppId } from "../../../src/routing";
import { getActiveSession, type SessionUser } from "./auth";
import { enrolUrl, parseReturnTo, safeReturnUrl, signInUrl } from "./origins";
import { parsePlace } from "./place";
import { getAuth, getViewer } from "./server";

export type { SessionUser };

export type SignedIn = SessionUser & {
  // Address of every app this person can open. A turned-off app has no entry.
  apps: Partial<Record<AppId, string>>;
};

async function readSignedIn({ app, path }: { app: AppId; path: string }) {
  const request = getRequest();
  const { origins, settings } = await getAuth(request);
  const viewer = await getViewer(request);
  const here = new URL(path, origins[app]).href;
  if (viewer.status === "signed-out") {
    throw redirect({ href: signInUrl(origins, here) });
  }
  if (viewer.status === "must-enrol") {
    throw redirect({ href: enrolUrl(origins, here) });
  }
  const apps: SignedIn["apps"] = {};
  for (const id of Object.keys(APPS) as AppId[]) {
    if (!(settings.disabled as ReadonlySet<string>).has(id)) {
      apps[id] = `${origins[id]}/`;
    }
  }
  return { ...viewer.user, apps } satisfies SignedIn;
}

const requireUserOnServer = createServerFn({ method: "GET" })
  .validator(parsePlace)
  .handler(({ data }): Promise<SignedIn> => readSignedIn(data));

export function requireUser(
  app: AppId,
  location: { publicHref: string },
): Promise<SignedIn> {
  return requireUserOnServer({ data: { app, path: location.publicHref } });
}

export const prepareSignIn = createServerFn({ method: "GET" })
  .validator(parseReturnTo)
  .handler(async ({ data }): Promise<{ returnTo: string }> => {
    const request = getRequest();
    const { auth, origins } = await getAuth(request);
    const returnTo =
      (data.returnTo && safeReturnUrl(data.returnTo, origins)) ||
      `${origins.auth}/`;
    const session = await getActiveSession(auth, request.headers);
    if (session) throw redirect({ href: returnTo });
    return { returnTo };
  });
