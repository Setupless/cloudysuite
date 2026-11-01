export const APPS = {
  auth: { toggleable: false },
  mail: { toggleable: true },
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

export function gate(route: HostRoute, pathname: string): Gate {
  switch (route.kind) {
    case "setup":
      return isSetupPath(pathname)
        ? { action: "pass" }
        : { action: "redirect", to: "/setup" };
    case "off":
      return pathname === "/off"
        ? { action: "pass" }
        : { action: "redirect", to: "/off" };
    case "app":
      return isGatePath(pathname)
        ? { action: "redirect", to: "/" }
        : { action: "pass" };
    case "unknown":
      return { action: "notFound" };
  }
}
