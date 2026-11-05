import { useHydrated } from "@cloudysuite/ui";
import { IconHome } from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import type { ReactNode } from "react";

function Screen({
  title,
  subtitle,
  icon: EmptyIcon,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  icon: Icon;
  children: string;
}) {
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-3.5 pb-2.5">
        <h1 className="min-w-0 text-[21px] font-semibold break-words">
          {title}
        </h1>
        {subtitle && <p className="text-secondary">{subtitle}</p>}
      </div>
      <div className="mx-4 mt-2 flex flex-col items-center gap-2 rounded border border-line px-6 py-12 text-center">
        <EmptyIcon
          size={28}
          stroke={1.5}
          className="text-secondary"
          aria-hidden
        />
        <p className="text-sm text-secondary">{children}</p>
      </div>
    </>
  );
}

export function TodayScreen() {
  // The server doesn't know the reader's time zone, so the date waits for the browser.
  const hydrated = useHydrated();
  return (
    <Screen
      title="Today"
      subtitle={
        hydrated
          ? new Date().toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })
          : undefined
      }
      icon={IconHome}
    >
      Your day will show here: what's next, the rest of today, and tomorrow.
    </Screen>
  );
}
