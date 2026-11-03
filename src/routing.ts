export const APPS = {
  auth: { toggleable: false },
  mail: { toggleable: true },
  storage: { toggleable: true },
} as const;

export type AppId = keyof typeof APPS;

export type ToggleableApp = {
  [App in AppId]: (typeof APPS)[App]["toggleable"] extends true ? App : never;
}[AppId];

export type Settings = {
  primaryDomain: string | null;
  disabled: ReadonlySet<ToggleableApp>;
};

export type HostRoute =
  | { kind: "setup" }
  | { kind: "app"; app: AppId }
  | { kind: "off"; app: ToggleableApp }
  | { kind: "unknown" };

export type Gate =
  | { action: "pass" }
  | { action: "redirect"; to: string }
  | { action: "refuse"; app: ToggleableApp }
  | { action: "notFound" };

export function isAppId(label: string): label is AppId {
  return Object.hasOwn(APPS, label);
}

function isToggleable(app: AppId): app is ToggleableApp {
  return APPS[app].toggleable;
}

export function resolveHost(hostname: string, settings: Settings): HostRoute {
  if (settings.primaryDomain === null) return { kind: "setup" };

  const host = hostname.toLowerCase();
  const suffix = `.${settings.primaryDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return { kind: "unknown" };

  const label = host.slice(0, -suffix.length);
  if (!isAppId(label)) return { kind: "unknown" };

  if (isToggleable(label) && settings.disabled.has(label)) {
    return { kind: "off", app: label };
  }
  return { kind: "app", app: label };
}

// The wizard's page and its API. Everything else waits until setup finishes.
export function isSetupPath(pathname: string): boolean {
  return pathname === "/setup" || pathname.startsWith("/setup/");
}

export function isGatePath(pathname: string): boolean {
  return pathname === "/off" || isSetupPath(pathname);
}

// Outside every app's prefix because it must render with no signed-in person. Only
// Mail's service worker asks for it.
export const OFFLINE_SHELL_PATH = "/offline-shell";

// Answered while Mail is off, with an id or a 401 and no mail. Sign-out and a session
// ending elsewhere must still clear a device then, and only this answer may clear it.
// Only GET has a handler. Any other method would fall through to a rendered page, and
// that page carries the signed-in person's details.
export const DEVICE_SESSION_PATH = "/pwa/session";

export function gate(route: HostRoute, request: Request): Gate {
  const { pathname } = new URL(request.url);
  switch (route.kind) {
    case "setup":
      return isSetupPath(pathname)
        ? { action: "pass" }
        : { action: "redirect", to: "/setup" };
    case "off":
      if (
        pathname === "/off" ||
        (route.app === "mail" &&
          pathname === DEVICE_SESSION_PATH &&
          request.method === "GET")
      ) {
        return { action: "pass" };
      }
      // A page that was open when the app went off keeps calling it, and a redirect
      // would reach that page as an answer it can't read.
      return request.headers.get("Sec-Fetch-Mode") === "navigate"
        ? { action: "redirect", to: "/off" }
        : { action: "refuse", app: route.app };
    case "app":
      if (pathname === OFFLINE_SHELL_PATH && route.app !== "mail") {
        return { action: "notFound" };
      }
      return isGatePath(pathname)
        ? { action: "redirect", to: "/" }
        : { action: "pass" };
    case "unknown":
      return { action: "notFound" };
  }
}
