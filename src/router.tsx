import { createRouter } from "@tanstack/react-router";
import { isAppId, isGatePath } from "./routing";
import { routeTree } from "./routeTree.gen";

function appPrefix(url: URL): string | null {
  if (isGatePath(url.pathname)) return null;
  const label = url.hostname.split(".")[0]?.toLowerCase() ?? "";
  return isAppId(label) ? `/${label}` : null;
}

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
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
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
