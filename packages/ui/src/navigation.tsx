import { useLocation, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PROGRESS_DELAY_MS } from "./skeleton";

const FINISH_MS = 300;

// A path parameter of the page being opened, or of the page on screen when nothing is
// opening. A sidebar marks what someone chose with this, so the mark moves on the click
// rather than once the page has loaded.
export function useDestinationParam(name: string): string | undefined {
  const router = useRouter();
  return useLocation({
    select: (location) => router.getMatchedRoutes(location.pathname)[1][name],
  });
}

// "slow" once a page change has taken long enough to show the bar, then "finishing"
// while the bar fills and fades.
export type NavigationProgress = "idle" | "slow" | "finishing";

export function useNavigationProgress(): NavigationProgress {
  // Same address means the page on screen is reloading its data, not changing.
  const navigating = useRouterState({
    select: (state) =>
      state.status === "pending" &&
      state.location.href !== state.resolvedLocation?.href,
  });
  const [progress, setProgress] = useState<NavigationProgress>("idle");

  useEffect(() => {
    if (navigating) {
      const timer = setTimeout(() => setProgress("slow"), PROGRESS_DELAY_MS);
      return () => clearTimeout(timer);
    }
    setProgress((current) => (current === "slow" ? "finishing" : current));
  }, [navigating]);

  useEffect(() => {
    if (progress !== "finishing") return;
    const timer = setTimeout(() => setProgress("idle"), FINISH_MS);
    return () => clearTimeout(timer);
  }, [progress]);

  return progress;
}

export function ProgressBar({ progress }: { progress: NavigationProgress }) {
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
