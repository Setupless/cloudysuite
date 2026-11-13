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

// The browser's copy of who is signed in, so a click doesn't wait on the server. Every
// server function checks the session itself, and a 401 reloads the page, so this copy
// only ever decides what the shell shows. On the server it stays empty, because one
// Worker serves many people.
let remembered: SignedIn | undefined;

export function rememberedUser(): SignedIn | undefined {
  return remembered;
}

export function rememberUser(user: SignedIn): SignedIn {
  if (!import.meta.env.SSR) remembered = user;
  return user;
}

export async function requireRememberedUser(
  app: AppId,
  {
    location,
    matches,
  }: { location: { publicHref: string }; matches: { invalid: boolean }[] },
): Promise<SignedIn> {
  if (import.meta.env.SSR) return requireUser(app, location);
  // A page loads again after a change that can affect its own person, such as an admin
  // requiring two-step sign-in, so that load asks the server.
  if (!remembered || matches.some((match) => match.invalid)) {
    remembered = await requireUser(app, location);
  }
  return remembered;
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
