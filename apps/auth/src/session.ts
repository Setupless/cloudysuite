import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { APPS, type AppId } from "../../../src/routing";
import { getActiveSession, type SessionUser } from "./auth";
import { enrolUrl, parseReturnTo, safeReturnUrl, signInUrl } from "./origins";
import { parsePlace } from "./place";
import { createRememberedUser, type Refusal } from "./remembered-user";
import { getAuth, getViewer } from "./server";

export type { SessionUser };
export type { Refusal } from "./remembered-user";

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

const remembered = createRememberedUser({
  ask: (app, path) => requireUser(app, { publicHref: path }),
  reload: () => window.location.reload(),
  online: () => navigator.onLine,
});

// On the server the copy stays empty, because one Worker serves many people.
export function rememberUser(user: SignedIn): void {
  if (!import.meta.env.SSR) remembered.remember(user);
}

export function requireRememberedUser(
  app: AppId,
  location: { publicHref: string },
  ask: () => Promise<SignedIn> = () => requireUser(app, location),
): Promise<SignedIn> {
  if (import.meta.env.SSR) return requireUser(app, location);
  return remembered.require(ask);
}

// Auth's own actions, such as an admin requiring two-step sign-in, can change the
// person this page shows. Each tells the router, and the load that follows asks.
export function requireAuthUser({
  location,
  matches,
}: {
  location: { publicHref: string };
  matches: { invalid: boolean }[];
}): Promise<SignedIn> {
  if (import.meta.env.SSR) return requireUser("auth", location);
  const askAgain = matches.some((match) => match.invalid);
  return remembered.require(() => requireUser("auth", location), askAgain);
}

export const recheckRememberedUser = remembered.recheck;

export function noticeRefusal(
  ...refused: Parameters<typeof remembered.noticeRefusal>
): void {
  if (!import.meta.env.SSR) remembered.noticeRefusal(...refused);
}

// What each app's query client does with a refused request. `signedOut` runs on a 401,
// and every other refusal may mean the copy is out of date.
export function answerRefusals(
  failure: abstract new (...args: never[]) => Error & Refusal,
  signedOut: () => void,
) {
  const notice = (error: Error, from: object, opening: boolean) => {
    if (!(error instanceof failure)) return;
    if (error.status === 401) signedOut();
    else noticeRefusal(error, { from, opening });
  };
  return {
    notice,
    // A hover loads a page's data before anyone sees it, so only a refusal that a page
    // shows counts. A page that opens on a refused load asks again.
    query: (
      error: Error,
      query: { isActive: () => boolean; state: { data: unknown } },
    ) => {
      if (query.isActive())
        notice(error, query, query.state.data === undefined);
    },
    mutation: (
      error: Error,
      _variables: unknown,
      _result: unknown,
      mutation: object,
    ) => notice(error, mutation, false),
  };
}

// Someone who signs out or in as another person in another tab or window comes back to
// this one afterwards, so that is when the copy is checked again.
export function watchRememberedUser(
  app: AppId,
  router: { invalidate: () => Promise<unknown> },
): void {
  remembered.watch({
    app,
    path: () => location.pathname + location.search + location.hash,
    refresh: () => router.invalidate(),
  });
  let away = document.visibilityState === "hidden";
  const leave = () => {
    away = true;
  };
  const back = () => {
    if (!away || document.visibilityState === "hidden") return;
    away = false;
    void remembered.recheck();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leave();
    else back();
  });
  // Focus that moves into a message's frame stays on this page.
  addEventListener("blur", () => {
    if (!document.hasFocus()) leave();
  });
  addEventListener("focus", back);
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
