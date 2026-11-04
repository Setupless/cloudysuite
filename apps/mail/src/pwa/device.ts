import type { SignedIn } from "@cloudysuite/auth/session";
import type { QueryClient } from "@tanstack/react-query";
import { isOffline, isPageHidden, markReachable } from "./connectivity";
import {
  clearDevice,
  onDeviceCleared,
  readOwner,
  readServerSession,
  saveOwner,
} from "./device-store";
import { isOwnerExpired, type DeviceOwner } from "./offline-model";
import { setSavedMailReader } from "./saved-mail";
import { DEVICE_CLEARED_PATH } from "./sw-policy";
import { saveMailForOffline } from "./sync";
import { runWhileVisible, type VisibleWork } from "./while-visible";

const REFRESH_SAVED_MAIL_MS = 5 * 60 * 1000;
const FIRST_SAVE_MAX_WAIT_MS = 5_000;

// For a page started by the service worker with no connection: who this device's mail
// belongs to, if that is still safe to trust. Past that, the clearing page takes over,
// because clearing here would also remove the files this page still needs to load.
export async function readTrustedOwner(): Promise<DeviceOwner | null> {
  const owner = await readOwner();
  if (!owner) return null;
  if (!isOwnerExpired(owner, Date.now())) return owner;
  location.replace(DEVICE_CLEARED_PATH);
  return new Promise(() => {});
}

// Clears the device and reloads when the browser's session no longer belongs to the
// person this tab is showing. The reload reaches the server's own sign-in check.
async function confirmOwner(user: SignedIn): Promise<boolean> {
  const session = await readServerSession();
  if (session.kind === "unknown") return false;
  if (session.kind === "signed-out" || session.userId !== user.id) {
    await clearDevice();
    location.reload();
    return false;
  }
  const owner = await readOwner();
  if (owner && owner.user.id !== user.id) await clearDevice();
  await saveOwner({ user, verifiedAt: Date.now() });
  return true;
}

// A browser with the service worker off still gets the rest of Mail.
async function registerWorker(): Promise<void> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
  } catch (error) {
    console.error("Could not set up offline reading.", error);
  }
}

function followColorScheme(): () => void {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  const update = () => {
    meta.content = getComputedStyle(document.body).backgroundColor;
  };
  update();
  document.head.appendChild(meta);
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", update);
  return () => {
    scheme.removeEventListener("change", update);
    meta.remove();
  };
}

// The first save would otherwise put the page's own requests in a queue behind it. The
// cap is there because a request that never ends must not hold back the owner check.
function afterPageLoads(client: QueryClient): Promise<void> {
  return new Promise((resolve) => {
    let stopWatching = () => {};
    const done = () => {
      clearTimeout(cap);
      stopWatching();
      resolve();
    };
    const cap = setTimeout(done, FIRST_SAVE_MAX_WAIT_MS);
    const whenIdle = () => {
      stopWatching();
      if (typeof requestIdleCallback === "function") requestIdleCallback(done);
      else setTimeout(done, 0);
    };
    if (client.isFetching() === 0) return whenIdle();
    stopWatching = client.getQueryCache().subscribe(() => {
      if (client.isFetching() === 0) whenIdle();
    });
  });
}

export function startDevice(user: SignedIn, client: QueryClient): () => void {
  setSavedMailReader(user.id);
  void registerWorker();

  const refresh = async () => {
    if (isOffline()) return;
    if (await confirmOwner(user)) await saveMailForOffline(user.id);
  };
  let stopped = false;
  let savedMail: VisibleWork | null = null;
  void afterPageLoads(client).then(() => {
    if (stopped) return;
    savedMail = runWhileVisible(() => void refresh(), REFRESH_SAVED_MAIL_MS);
  });

  // Hidden, this only marks everything out of date, and Query fetches it on return.
  const reconnect = () => {
    markReachable();
    void client.invalidateQueries({
      refetchType: isPageHidden() ? "none" : "active",
    });
    savedMail?.runSoon();
  };
  addEventListener("online", reconnect);

  // A page restored by the back button skips every server check, and it may show the
  // person who just signed out.
  const restored = (event: PageTransitionEvent) => {
    if (event.persisted) location.reload();
  };
  addEventListener("pageshow", restored);

  const stopListening = onDeviceCleared(() => location.reload());
  const stopColours = followColorScheme();
  return () => {
    stopped = true;
    savedMail?.stop();
    removeEventListener("online", reconnect);
    removeEventListener("pageshow", restored);
    stopListening();
    stopColours();
  };
}

export { clearDevice };
