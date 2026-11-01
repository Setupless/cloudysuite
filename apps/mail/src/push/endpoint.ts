// A browser hands us its endpoint, and the Worker later sends a request to it, so an
// open list would let anyone signed in aim the Worker at any URL. Each entry is a push
// service's own domain, matched exactly or as a parent of the endpoint's host.
const PUSH_SERVICES = {
  // Chrome, Android, Brave, and Opera. Chromium handed out the second host when
  // subscribing on 2026-11-01, though Google's documents only name the first.
  exact: ["fcm.googleapis.com", "jmt17.google.com"],
  // Firefox, Safari, and Edge on Windows hand out varying subdomains.
  parents: [
    "push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
  ],
} as const;

const MAX_ENDPOINT_LENGTH = 1024;

export function parsePushEndpoint(raw: string): string | null {
  if (raw.length > MAX_ENDPOINT_LENGTH) return null;
  const url = URL.parse(raw);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const known =
    (PUSH_SERVICES.exact as readonly string[]).includes(host) ||
    PUSH_SERVICES.parents.some((parent) => host.endsWith(`.${parent}`));
  return known ? url.href : null;
}
