import { useSyncExternalStore } from "react";

// `navigator.onLine` only knows about the network card, so a request that fails on a
// dead connection also counts. The next request that succeeds clears it.
let unreachable = false;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function markReachable(): void {
  if (!unreachable) return;
  unreachable = false;
  changed();
}

export function markUnreachable(): void {
  if (unreachable) return;
  unreachable = true;
  changed();
}

export const isOffline = (): boolean =>
  typeof navigator !== "undefined" && (!navigator.onLine || unreachable);

function subscribe(listener: () => void) {
  listeners.add(listener);
  addEventListener("online", listener);
  addEventListener("offline", listener);
  return () => {
    listeners.delete(listener);
    removeEventListener("online", listener);
    removeEventListener("offline", listener);
  };
}

export const useOffline = (): boolean =>
  useSyncExternalStore(subscribe, isOffline, () => false);

// A dead connection is the one failure that throws TypeError from fetch. A server's
// answer arrives as a Response, or as an Error it sent.
export const isConnectionFailure = (thrown: unknown): boolean =>
  thrown instanceof TypeError;
