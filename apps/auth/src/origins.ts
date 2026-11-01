import { APPS, type AppId } from "../../../src/routing";

export type AppOrigins = Readonly<Record<AppId, string>>;

const isLocal = (domain: string) =>
  domain === "localhost" || domain.endsWith(".localhost");

// A real deployment is always https on the default port. `.localhost` never
// resolves publicly, so only local dev servers reach this branch, and they
// differ in scheme and port: portless, vite dev, and wrangler dev.
function localBase(request: Request): { protocol: string; port: string } {
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-proto");
  if (!forwarded) return { protocol: url.protocol, port: url.port };
  return {
    protocol: `${forwarded}:`,
    port: request.headers.get("x-forwarded-port") ?? "",
  };
}

export function appOrigins(
  primaryDomain: string,
  request: Request,
): AppOrigins {
  const { protocol, port } = isLocal(primaryDomain)
    ? localBase(request)
    : { protocol: "https:", port: "" };
  const originOf = (app: AppId) => {
    const url = new URL(`${protocol}//${app}.${primaryDomain}`);
    url.port = port;
    return url.origin;
  };
  return Object.fromEntries(
    Object.keys(APPS).map((app) => [app, originOf(app as AppId)]),
  ) as Record<AppId, string>;
}

export function safeReturnUrl(
  candidate: string,
  origins: AppOrigins,
): string | null {
  const url = URL.parse(candidate);
  if (!url || url.username || url.password) return null;
  return Object.values(origins).includes(url.origin) ? url.href : null;
}

export function signInUrl(origins: AppOrigins, returnTo: string): string {
  const url = new URL("/sign-in", origins.auth);
  const safe = safeReturnUrl(returnTo, origins);
  if (safe) url.searchParams.set("returnTo", safe);
  return url.href;
}
