import { type ReactNode, useEffect } from "react";

let covers = 0;

// The page that replaces a skeleton shows its own loading rows at once, instead of
// after the pause that keeps them from blinking on a quick load.
export const skeletonShown = (): boolean => covers > 0;

// Hides the page under it, and fades in slowly at first, so one that's cut short a
// few milliseconds in stays too faint to read as a flash. Screen readers skip it,
// because the page area tells them it's busy.
export function SkeletonCover({ children }: { children: ReactNode }) {
  useEffect(() => {
    covers += 1;
    return () => {
      covers -= 1;
    };
  }, []);
  return (
    <div
      aria-hidden
      className="absolute inset-0 z-40 bg-page transition-opacity duration-200 ease-in starting:opacity-0 motion-reduce:delay-150 motion-reduce:duration-0"
    >
      <div className="sticky top-0 flex h-full max-h-dvh flex-col">
        {children}
      </div>
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
