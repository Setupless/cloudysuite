/// <reference lib="webworker" />
import { notificationFor, parsePushMessage } from "../push/notice";
import { clearDevice, readOwner, readServerSession } from "./device-store";
import { CACHE_PREFIX, policyFor, SHELL_PATH } from "./sw-policy";

declare const self: ServiceWorkerGlobalScope;
// Written in by the build: see build-plugin.ts.
declare const __BUILD_VERSION__: string;
declare const __BUILD_ASSETS__: string[];
declare const __PUBLIC_FILES__: string[];

const CACHE = `${CACHE_PREFIX}${__BUILD_VERSION__}`;
const PUBLIC_FILES = new Set(__PUBLIC_FILES__);
const ICON = "/icons/icon-192.png";

// All or nothing: if a file is missing the install fails and the last working version
// stays, so a half-saved build can never answer a request.
async function saveBuild(): Promise<void> {
  const cache = await caches.open(CACHE);
  await cache.addAll(
    [...__BUILD_ASSETS__, ...PUBLIC_FILES].map(
      (path) => new Request(path, { cache: "reload" }),
    ),
  );
  // Refusing a redirect stops the "Mail is turned off" page being saved as the shell.
  const shell = await fetch(SHELL_PATH, { cache: "reload", redirect: "error" });
  if (!shell.ok) throw new Error("The offline page isn't available.");
  await cache.put(SHELL_PATH, shell);
}

self.addEventListener("install", (event) => {
  event.waitUntil(saveBuild().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
      await self.registration.navigationPreload.enable();
    })(),
  );
});

// Whoever is signed in now decides. Someone who left, on this device or another, may
// have left it for the next person, and this runs without any page's code loading.
async function checkDeviceOwner(): Promise<void> {
  const owner = await readOwner();
  if (!owner) return;
  const session = await readServerSession();
  const gone =
    session.kind === "signed-out" ||
    (session.kind === "signed-in" && session.userId !== owner.user.id);
  if (gone) await clearDevice();
}

// A page load's request leaves while this worker is still starting, and its answer
// waits in `preloadResponse`.
async function fromNetwork(event: FetchEvent): Promise<Response> {
  const preloaded: Response | undefined = await event.preloadResponse;
  return preloaded ?? fetch(event.request);
}

async function page(event: FetchEvent): Promise<Response> {
  try {
    const response = await fromNetwork(event);
    event.waitUntil(checkDeviceOwner().catch(() => {}));
    return response;
  } catch (networkFailure) {
    const shell = await caches.match(SHELL_PATH, { cacheName: CACHE });
    if (shell) return shell;
    throw networkFailure;
  }
}

async function publicFile(event: FetchEvent): Promise<Response> {
  try {
    return await fromNetwork(event);
  } catch (networkFailure) {
    const saved = await caches.match(event.request, { cacheName: CACHE });
    if (saved) return saved;
    throw networkFailure;
  }
}

async function buildAsset(event: FetchEvent): Promise<Response> {
  // Any version's copy will do: a page from the last build asks for the last build's
  // files by their exact hashed names.
  return (await caches.match(event.request)) ?? fromNetwork(event);
}

self.addEventListener("fetch", (event) => {
  const policy = policyFor(event.request, self.location.origin, PUBLIC_FILES);
  switch (policy.kind) {
    case "network":
      return;
    case "buildAsset":
      event.respondWith(buildAsset(event));
      return;
    case "publicFile":
      event.respondWith(publicFile(event));
      return;
    case "page":
      event.respondWith(page(event));
      return;
    case "preloaded":
      event.respondWith(fromNetwork(event));
      return;
  }
});

async function showPush(event: PushEvent): Promise<void> {
  let raw: unknown = null;
  try {
    raw = event.data?.json();
  } catch {
    return;
  }
  const message = parsePushMessage(raw);
  if (!message) return;
  // This browser may have passed to someone else before its old subscription ended.
  const owner = await readOwner();
  if (owner?.user.id !== message.to) {
    const subscription = await self.registration.pushManager.getSubscription();
    await subscription?.unsubscribe();
    return;
  }
  const shown = notificationFor(message);
  await self.registration.showNotification(shown.title, {
    body: shown.body,
    tag: shown.tag,
    icon: ICON,
    data: message,
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

async function openNotification(event: NotificationEvent): Promise<void> {
  event.notification.close();
  const message = parsePushMessage(event.notification.data);
  const url = new URL(
    message ? notificationFor(message).path : "/",
    self.location.origin,
  ).href;
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    const navigated = await client.navigate(url).catch(() => null);
    if (navigated) {
      await navigated.focus();
      return;
    }
  }
  await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.waitUntil(openNotification(event));
});
