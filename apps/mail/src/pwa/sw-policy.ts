// How the service worker treats a request. Anything without a reason to be here goes
// straight to the network, untouched and uncached: sign-in, server functions, downloads,
// and every other request a later change adds.
export type RequestPolicy =
  // Content-hashed, so a saved copy can never be wrong for that name.
  | { kind: "buildAsset" }
  // Public files with fixed names: the network's copy, or the saved one offline.
  | { kind: "publicFile" }
  // A page holding someone's mail is never saved. Offline gets the anonymous shell.
  | { kind: "page" }
  // Any other page load, such as a download. The browser has already sent it as the
  // navigation preload, and letting it pass would send it a second time.
  | { kind: "preloaded" }
  | { kind: "network" };

export const SHELL_PATH = "/offline-shell";
export const DEVICE_CLEARED_PATH = "/device-cleared";
export const CACHE_PREFIX = "cloudysuite-mail-";

const NEVER_A_PAGE = ["/api/", "/_serverFn/", "/download/", "/pwa/"];

export function policyFor(
  request: { method: string; mode: string; url: string },
  ownOrigin: string,
  publicFiles: ReadonlySet<string>,
): RequestPolicy {
  if (request.method !== "GET") return { kind: "network" };
  const url = new URL(request.url);
  if (url.origin !== ownOrigin) return { kind: "network" };
  if (url.pathname.startsWith("/assets/")) return { kind: "buildAsset" };
  if (publicFiles.has(url.pathname)) return { kind: "publicFile" };
  if (request.mode !== "navigate") return { kind: "network" };
  if (url.pathname === SHELL_PATH) return { kind: "preloaded" };
  return NEVER_A_PAGE.some((prefix) => url.pathname.startsWith(prefix))
    ? { kind: "preloaded" }
    : { kind: "page" };
}
