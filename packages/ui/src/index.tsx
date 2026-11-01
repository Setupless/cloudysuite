import type { Icon } from "@tabler/icons-react";

export function Page({
  icon: PageIcon,
  title,
  children,
}: {
  icon: Icon;
  title: string;
  children: string;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page p-6 text-text">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-sidebar text-accent">
          <PageIcon size={28} stroke={1.5} aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-secondary">{children}</p>
      </div>
    </main>
  );
}
