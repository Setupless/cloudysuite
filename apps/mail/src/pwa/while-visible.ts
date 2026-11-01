export type PageVisibility = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

export type VisibleWork = {
  // Runs now if someone can see the page, or as soon as someone can.
  runSoon: () => void;
  stop: () => void;
};

// Each request renews the session, so a tab nobody is looking at must make none. If it
// did, a forgotten tab would keep a person signed in forever. Coming back after a full
// interval runs the work at once, so a session that ended meanwhile is found straight away.
export function runWhileVisible(
  work: () => void,
  intervalMs: number,
  page: PageVisibility = document,
): VisibleWork {
  let lastRun = Number.NEGATIVE_INFINITY;
  const isHidden = () => page.visibilityState === "hidden";
  const run = () => {
    lastRun = Date.now();
    work();
  };
  const onTick = () => {
    if (!isHidden()) run();
  };
  const onVisibilityChange = () => {
    if (!isHidden() && Date.now() - lastRun >= intervalMs) run();
  };

  onVisibilityChange();
  const timer = setInterval(onTick, intervalMs);
  page.addEventListener("visibilitychange", onVisibilityChange);
  return {
    runSoon: () => {
      lastRun = Number.NEGATIVE_INFINITY;
      onVisibilityChange();
    },
    stop: () => {
      clearInterval(timer);
      page.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
