import {
  type AnyRouter,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";
import { SkeletonCover } from "./skeleton";

// How long a page change waits before each sign that it's still going. A page that has
// been opened once opens again in a few milliseconds, so neither sign shows then.
export const PROGRESS_DELAY_MS = 150;
export const SKELETON_DELAY_MS = 400;
const FINISH_MS = 300;

export type PageChange = {
  // "slow" once a change of address has taken long enough to show the bar, then
  // "finishing" while the bar fills and fades.
  progress: "idle" | "slow" | "finishing";
  // A change to another page, not only to a new search, has taken long enough to
  // show that page's skeleton.
  skeleton: boolean;
  // The address being opened, while one is.
  to: string | null;
  // Counts the changes, so a page can tell one from the next.
  change: number;
};

const IDLE: PageChange = {
  progress: "idle",
  skeleton: false,
  to: null,
  change: 0,
};

type Watcher = {
  get: () => PageChange;
  listen: (listener: () => void) => () => void;
};

// Router events, because each says where a change is going and whether it's another
// page, and a change replaced by another ends only with the last one's onResolved.
function watch(router: AnyRouter): Watcher {
  let state = IDLE;
  let opening = false;
  let due = false;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let finishing: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  const set = (next: Partial<PageChange>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const settle = () => {
    if (state.to === null) return;
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    opening = false;
    due = false;
    if (state.progress === "slow") {
      finishing = setTimeout(() => set({ progress: "idle" }), FINISH_MS);
    }
    set({
      to: null,
      skeleton: false,
      progress: state.progress === "slow" ? "finishing" : state.progress,
    });
  };

  // A timer that finds the router idle settles, in case its last event never came.
  const later = (delay: number, run: () => void) =>
    setTimeout(() => {
      if (router.state.status === "pending") run();
      else settle();
    }, delay);

  router.subscribe("onBeforeLoad", (event) => {
    // The same address again: the page on screen is reloading its data.
    if (!event.hrefChanged) {
      settle();
      return;
    }
    opening = event.pathChanged && event.fromLocation !== undefined;
    if (state.to === null) {
      clearTimeout(finishing);
      timers = [
        later(PROGRESS_DELAY_MS, () => set({ progress: "slow" })),
        later(SKELETON_DELAY_MS, () => {
          due = true;
          set({ skeleton: opening });
        }),
      ];
      set({
        progress: "idle",
        to: event.toLocation.href,
        skeleton: false,
        change: state.change + 1,
      });
      return;
    }
    set({ to: event.toLocation.href, skeleton: due && opening });
  });
  router.subscribe("onResolved", settle);

  return {
    get: () => state,
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const watchers = new WeakMap<AnyRouter, Watcher>();

// One watcher for each router, shared by the bar and every page area.
export function watchPageChanges(router: AnyRouter): Watcher {
  let watcher = watchers.get(router);
  if (!watcher) {
    watcher = watch(router);
    watchers.set(router, watcher);
  }
  return watcher;
}

export function usePageChange(): PageChange {
  const router = useRouter();
  const listen = useCallback(
    (listener: () => void) => watchPageChanges(router).listen(listener),
    [router],
  );
  const get = useCallback(() => watchers.get(router)?.get() ?? IDLE, [router]);
  return useSyncExternalStore(listen, get, () => IDLE);
}

// A path parameter of the page someone chose: the one opening, or the one on screen
// when nothing is. A sidebar marks the choice with this, so the mark moves on the
// click rather than once the page has loaded. Undefined unless that page is `to` or
// under it.
export function chosenParam(
  router: AnyRouter,
  to: string,
  name: string,
): string | undefined {
  const pending = router.state.status === "pending";
  const params = router.matchRoute(
    { to },
    { fuzzy: true, includeSearch: false, pending: pending || undefined },
  );
  return params ? params[name] : undefined;
}

export function useChosenParam(to: string, name: string): string | undefined {
  const router = useRouter();
  return useRouterState({ select: () => chosenParam(router, to, name) });
}

export type PendingPage = {
  // A route path, such as "/storage/drive/$driveId". The first one that matches the
  // page being opened is used, so a path that names a page comes before a pattern
  // that would also match it.
  to: string;
  // The page and every page under it share this area's content, so moving between
  // them keeps what's there.
  under?: boolean;
  skeleton: ComponentType;
};

const sameParams = (a: Record<string, string>, b: Record<string, string>) =>
  [...Object.keys(a), ...Object.keys(b)].every(
    (key) => key === "**" || a[key] === b[key],
  );

// The router matches an address that ends in a slash, as every app's home page does,
// only loosely, so a loose match that adds nothing but that slash counts as exact.
function matchPage(router: AnyRouter, page: PendingPage, pending?: true) {
  const params = router.matchRoute(
    { to: page.to },
    { fuzzy: true, includeSearch: false, pending },
  );
  if (!params) return false;
  const rest = params["**"];
  return page.under || rest === undefined || rest === "/" ? params : false;
}

// The skeleton of the page being opened, or null when this area keeps its content.
export function pendingSkeleton(
  router: AnyRouter,
  pages: readonly PendingPage[],
): ComponentType | null {
  for (const page of pages) {
    const next = matchPage(router, page, true);
    if (!next) continue;
    const now = matchPage(router, page);
    return now && sameParams(now, next) ? null : page.skeleton;
  }
  return null;
}

// Where a page draws. A slow change to another page covers it with that page's
// skeleton, and the page itself stays until the new one replaces it, so focus stays
// where it was. Someone who moves through the covered page with the keyboard sees it
// again.
export function PageArea({
  pages,
  className,
  children,
}: {
  pages: readonly PendingPage[];
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { skeleton, change } = usePageChange();
  const [revealed, setRevealed] = useState(0);
  const Skeleton =
    skeleton && revealed !== change ? pendingSkeleton(router, pages) : null;
  const reveal = Skeleton ? () => setRevealed(change) : undefined;
  return (
    <div
      className={Skeleton ? `${className ?? ""} relative isolate` : className}
      onFocus={reveal}
      onKeyDown={reveal}
    >
      {children}
      {Skeleton && (
        <SkeletonCover>
          <Skeleton />
        </SkeletonCover>
      )}
    </div>
  );
}

export function ProgressBar({
  progress,
}: {
  progress: PageChange["progress"];
}) {
  if (progress === "idle") return null;
  const motion =
    progress === "slow"
      ? "scale-x-[0.85] duration-[8s] ease-[cubic-bezier(0.1,0.8,0.2,1)] starting:scale-x-0"
      : "scale-x-100 opacity-0 duration-300 ease-out";
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
    >
      <span
        className={`block h-full origin-left bg-accent transition-[scale,opacity] motion-reduce:scale-x-100 motion-reduce:transition-none ${motion}`}
      />
    </span>
  );
}
