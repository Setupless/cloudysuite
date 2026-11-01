import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { isPageHidden } from "./connectivity";
import { type PageVisibility, runWhileVisible } from "./while-visible";

const INTERVAL_MS = 5 * 60 * 1000;
const START = new Date("2026-11-02T00:00:00Z").getTime();

type FakeInterval = { callback: () => void; every: number };

function fakePage(state: DocumentVisibilityState = "visible") {
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: state,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  };
  return {
    page: page as unknown as PageVisibility,
    listeners,
    show(next: DocumentVisibilityState) {
      page.visibilityState = next;
      for (const listener of listeners) listener();
    },
  };
}

// Timers stand still, so a test says exactly when an interval fires.
function fakeClock() {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const running = new Set<FakeInterval>();
  globalThis.setInterval = ((callback: () => void, every: number) => {
    const entry = { callback, every };
    running.add(entry);
    return entry;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((entry: FakeInterval) =>
    running.delete(entry)) as unknown as typeof clearInterval;
  let now = START;
  setSystemTime(new Date(now));
  return {
    running,
    pass(ms: number) {
      now += ms;
      setSystemTime(new Date(now));
      for (const { callback, every } of running) {
        if (every <= ms) callback();
      }
    },
    restore() {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      setSystemTime();
    },
  };
}

const realDocument = globalThis.document;
afterEach(() => {
  (globalThis as { document?: unknown }).document = realDocument;
  onlineManager.setOnline(true);
});

const setVisibility = (visibilityState: DocumentVisibilityState) => {
  (globalThis as { document?: unknown }).document = { visibilityState };
};

test("a hidden tab does no work, however long it is left", () => {
  const clock = fakeClock();
  try {
    const { page } = fakePage("hidden");
    let runs = 0;
    const work = runWhileVisible(() => runs++, INTERVAL_MS, page);
    for (let tick = 0; tick < 500; tick++) clock.pass(INTERVAL_MS);
    expect(runs).toBe(0);
    work.stop();
  } finally {
    clock.restore();
  }
});

test("a visible tab keeps working, because being on screen counts as use", () => {
  const clock = fakeClock();
  try {
    const { page } = fakePage();
    let runs = 0;
    const work = runWhileVisible(() => runs++, INTERVAL_MS, page);
    expect(runs).toBe(1);
    clock.pass(INTERVAL_MS);
    clock.pass(INTERVAL_MS);
    expect(runs).toBe(3);
    work.stop();
  } finally {
    clock.restore();
  }
});

test("coming back after a long time checks at once, and a quick look does not", () => {
  const clock = fakeClock();
  try {
    const { page, show } = fakePage();
    let runs = 0;
    const work = runWhileVisible(() => runs++, INTERVAL_MS, page);
    expect(runs).toBe(1);

    show("hidden");
    show("visible");
    expect(runs).toBe(1);

    show("hidden");
    clock.pass(INTERVAL_MS * 3);
    expect(runs).toBe(1);
    show("visible");
    expect(runs).toBe(2);
    work.stop();
  } finally {
    clock.restore();
  }
});

test("reconnecting while hidden waits for the person to come back", () => {
  const clock = fakeClock();
  try {
    const { page, show } = fakePage();
    let runs = 0;
    const work = runWhileVisible(() => runs++, INTERVAL_MS, page);
    show("hidden");
    work.runSoon();
    expect(runs).toBe(1);
    show("visible");
    expect(runs).toBe(2);
    work.runSoon();
    expect(runs).toBe(3);
    work.stop();
  } finally {
    clock.restore();
  }
});

test("stopping removes the timer and the listener", () => {
  const clock = fakeClock();
  try {
    const { page, listeners } = fakePage();
    runWhileVisible(() => {}, INTERVAL_MS, page).stop();
    expect(clock.running.size).toBe(0);
    expect(listeners.size).toBe(0);
  } finally {
    clock.restore();
  }
});

// Query's own behaviour is what the mail lists rely on, so these pin it to this version.
// It sets no refetch timers outside a browser, so the real run covers its timed refresh.
function watchedQuery(onFetch: () => void) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "always",
        staleTime: 0,
        refetchOnWindowFocus: true,
        refetchOnReconnect: () => !isPageHidden(),
      },
    },
  });
  client.mount();
  const observer = new QueryObserver(client, {
    queryKey: ["mail"],
    queryFn: async () => {
      onFetch();
      return Date.now();
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  return {
    settle: () => new Promise((resolve) => setTimeout(resolve, 40)),
    stop: () => {
      unsubscribe();
      client.unmount();
      client.clear();
    },
  };
}

test("returning to a tab refreshes what went stale while hidden", async () => {
  let fetches = 0;
  setVisibility("hidden");
  const query = watchedQuery(() => fetches++);
  try {
    await query.settle();
    const whenHidden = fetches;

    setVisibility("visible");
    focusManager.onFocus();
    await query.settle();
    expect(fetches).toBe(whenHidden + 1);
  } finally {
    query.stop();
  }
});

test("a connection coming back does not refresh a hidden tab", async () => {
  let fetches = 0;
  setVisibility("hidden");
  const query = watchedQuery(() => fetches++);
  try {
    await query.settle();
    const before = fetches;
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await query.settle();
    expect(fetches).toBe(before);

    setVisibility("visible");
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await query.settle();
    expect(fetches).toBeGreaterThan(before);
  } finally {
    query.stop();
  }
});
