import { isRedirect } from "@tanstack/react-router";
import { APP_OFF_HEADER, APPS, type AppId } from "../../../src/routing";
import type { SignedIn } from "./session";

export type Refusal = { status: number; appOff: boolean };

type Browser = {
  ask: (app: AppId, path: string) => Promise<SignedIn>;
  reload: () => void;
  online: () => boolean;
};

type Watched = {
  app: AppId;
  path: () => string;
  refresh: () => Promise<unknown>;
};

const APP_IDS = Object.keys(APPS) as AppId[];

const sameUser = (a: SignedIn, b: SignedIn): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.email === b.email &&
  a.role === b.role &&
  APP_IDS.every((app) => a.apps[app] === b.apps[app]);

const isAppOff = (thrown: unknown): boolean =>
  thrown instanceof Response && thrown.headers.has(APP_OFF_HEADER);

// The browser's copy of who is signed in, so a click doesn't wait on the server. Every
// server function checks the session itself, so the copy only decides what the page
// shows, and it is checked again whenever something suggests it is out of date.
export function createRememberedUser(browser: Browser) {
  let copy: Promise<SignedIn> | undefined;
  let watched: Watched | undefined;
  let checking: Promise<boolean> | undefined;
  let leaving = false;
  const doubted = new WeakSet<object>();

  // Refusals keep arriving while the page loads again, and each would start it over.
  function reload(): true {
    if (!leaving) browser.reload();
    leaving = true;
    return true;
  }

  function hold(asking: Promise<SignedIn>): Promise<SignedIn> {
    copy = asking;
    asking.catch(() => {
      if (copy === asking) copy = undefined;
    });
    return asking;
  }

  // True when the copy was out of date and the page is changing to match the server.
  async function check(): Promise<boolean> {
    const held = copy;
    if (leaving) return true;
    if (!watched || !held || !browser.online()) return false;
    const before = await held.catch(() => undefined);
    if (!before) return false;
    let fresh: SignedIn;
    try {
      fresh = await browser.ask(watched.app, watched.path());
    } catch (thrown) {
      // Signed out, or told to add a second way to sign in. Without the copy, the
      // route's own check runs as a click's would, and sends the person on.
      if (isRedirect(thrown)) {
        copy = undefined;
        await watched.refresh();
        return true;
      }
      // An open page stays where it is. Its next load asks the server, whose refusal
      // sends the person to the page that says the app is off.
      if (isAppOff(thrown) && copy === held) copy = undefined;
      return false;
    }
    if (copy !== held || sameUser(fresh, before)) return false;
    // What this page already holds belongs to the person who was here before.
    if (fresh.id !== before.id) return reload();
    copy = Promise.resolve(fresh);
    await watched.refresh();
    return true;
  }

  function recheck(): Promise<boolean> {
    checking ??= check().finally(() => {
      checking = undefined;
    });
    return checking;
  }

  return {
    remember(user: SignedIn): void {
      copy = Promise.resolve(user);
    },

    require(ask: () => Promise<SignedIn>, askAgain = false): Promise<SignedIn> {
      if (copy && !askAgain) return copy;
      return hold(ask());
    },

    watch(page: Watched): void {
      watched = page;
    },

    recheck,

    // `from` is the refused query or mutation, and `opening` says it had nothing to
    // show yet, so the refusal stopped something from opening.
    noticeRefusal(
      { status, appOff }: Refusal,
      { from, opening }: { from: object; opening: boolean },
    ): void {
      if (appOff) {
        copy = undefined;
        if (opening) reload();
        return;
      }
      // Losing one calendar, drive, mailbox, or board is a 403 too, and a page can
      // keep refreshing what it lost, so each refused query asks only once.
      if (status !== 403 || doubted.has(from)) return;
      doubted.add(from);
      void recheck();
    },
  };
}
