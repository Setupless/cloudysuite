import { rememberUser, type SignedIn } from "@cloudysuite/auth/session";
import { createRouter } from "@tanstack/react-router";
import { isAppId, isGatePath, OFFLINE_SHELL_PATH } from "./routing";
import { routeTree } from "./routeTree.gen";

function appPrefix(url: URL): string | null {
  if (isGatePath(url.pathname) || url.pathname === OFFLINE_SHELL_PATH) {
    return null;
  }
  const label = url.hostname.split(".")[0]?.toLowerCase() ?? "";
  return isAppId(label) ? `/${label}` : null;
}

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    // A hover or touch runs the route's beforeLoad and loader early, so each must
    // only read. A mutation belongs in a handler that a click or a submit starts.
    defaultPreload: "intent",
    // The default 30 seconds lets a click skip the loader and show what a hover
    // loaded, however old. At 0 the click shows the hovered page at once and loads
    // its data again, as it did before preloading.
    defaultPreloadStaleTime: 0,
    // The first HTML already checked the session, so the browser keeps that answer
    // and its first click doesn't ask again.
    dehydrate: (): { user?: SignedIn } => ({
      user: router.state.matches.findLast(
        (match): match is typeof match & { context: { user: SignedIn } } =>
          "user" in match.context,
      )?.context.user,
    }),
    hydrate: ({ user }) => {
      if (user) rememberUser(user);
    },
    rewrite: {
      // The Worker has already checked the hostname by the time this runs, so
      // the first label is safe to trust. Every app gets a prefix, so
      // auth.<domain>/mail cannot reach Mail while Mail is off.
      input: ({ url }) => {
        const prefix = appPrefix(url);
        if (prefix) url.pathname = `${prefix}${url.pathname}`;
        return url;
      },
      output: ({ url }) => {
        const prefix = appPrefix(url);
        if (prefix && url.pathname.startsWith(prefix)) {
          url.pathname = url.pathname.slice(prefix.length) || "/";
        }
        return url;
      },
    },
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
