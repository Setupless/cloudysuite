import { type ReactNode, useEffect } from "react";

// How long a page change waits before each sign that it's still going. A page that has
// been opened once opens again in a few milliseconds, so neither sign shows then.
export const PROGRESS_DELAY_MS = 150;
export const SKELETON_DELAY_MS = 400;
// A skeleton isn't held up for a minimum time, because that holds back a page that's
// ready. It fades in slowly at first instead, so one that's cut short stays too faint
// to read as a flash.
export const SKELETON_MIN_MS = 0;

let skeletonsShown = 0;

// The page that replaces a skeleton shows its own loading rows at once, instead of
// after the pause that keeps them from blinking on a quick load.
export const skeletonShown = (): boolean => skeletonsShown > 0;

// Stands in for a page that's on its way. Screen readers skip it, because the page area
// tells them it's busy.
export function PageSkeleton({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    skeletonsShown += 1;
    return () => {
      skeletonsShown -= 1;
    };
  }, []);
  return (
    <div
      aria-hidden
      className={`transition-opacity duration-200 ease-in starting:opacity-0 motion-reduce:delay-150 motion-reduce:duration-0 ${className}`}
    >
      {children}
    </div>
  );
}

// A line of text or a control, at the size it will have.
export function Bone({ className }: { className: string }) {
  return (
    <span
      className={`block animate-pulse rounded bg-field motion-reduce:animate-none ${className}`}
    />
  );
}
