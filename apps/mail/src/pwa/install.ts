import { useSyncExternalStore } from "react";

export type InstallState =
  | { kind: "installed" }
  | { kind: "ready" }
  | { kind: "appleMobile" }
  | { kind: "appleDesktop" }
  | { kind: "notOffered" };

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let offered: InstallPrompt | null = null;
let installed = false;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

// Chromium fires this once, soon after load, and whoever is not listening misses it, so
// this runs when the module loads rather than when the page opens.
if (typeof window !== "undefined") {
  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    offered = event as InstallPrompt;
    changed();
  });
  addEventListener("appinstalled", () => {
    offered = null;
    installed = true;
    changed();
  });
}

export const isInstalledApp = (): boolean =>
  installed ||
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

export const isAppleMobile = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isSafariOnMac = (): boolean =>
  /macintosh/i.test(navigator.userAgent) &&
  /safari/i.test(navigator.userAgent) &&
  !/chrome|chromium|edg|firefox/i.test(navigator.userAgent);

const SNAPSHOTS = {
  installed: { kind: "installed" },
  ready: { kind: "ready" },
  appleMobile: { kind: "appleMobile" },
  appleDesktop: { kind: "appleDesktop" },
  notOffered: { kind: "notOffered" },
} as const satisfies Record<InstallState["kind"], InstallState>;

function readInstallState(): InstallState {
  if (isInstalledApp()) return SNAPSHOTS.installed;
  if (offered) return SNAPSHOTS.ready;
  if (isAppleMobile()) return SNAPSHOTS.appleMobile;
  if (isSafariOnMac()) return SNAPSHOTS.appleDesktop;
  return SNAPSHOTS.notOffered;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useInstallState = (): InstallState =>
  useSyncExternalStore(subscribe, readInstallState, () => SNAPSHOTS.notOffered);

export async function promptInstall(): Promise<void> {
  const prompt = offered;
  if (!prompt) return;
  await prompt.prompt();
  await prompt.userChoice;
  offered = null;
  changed();
}
