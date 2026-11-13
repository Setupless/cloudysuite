import {
  IconCloud,
  IconLogout,
  IconMenu2,
  IconUser,
} from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { type ReactNode, useId, useState } from "react";
import { ProgressBar, useNavigationProgress } from "./navigation";

export type ShellApp = {
  id: string;
  name: string;
  href: string;
  icon: Icon;
};

export type ShellPerson = { name: string; email: string };

export type AppShellProps = {
  currentApp: string;
  // Only the apps this person can open. A turned-off app is left out.
  apps: readonly ShellApp[];
  person: ShellPerson;
  accountHref: string;
  signOutHref: string;
  navigationLabel?: string;
  // Links styled with NAV_ITEM. Each app owns its own router links.
  navigation?: ReactNode;
  // Pinned to the bottom of the sidebar.
  sidebarFooter?: ReactNode;
  // In the top bar, between the menu button and the person's picture.
  headerContent?: ReactNode;
  children: ReactNode;
};

export const NAV_ITEM =
  "flex items-center gap-2.5 rounded px-2.5 py-1.5 text-sm text-text outline-accent hover:bg-field focus-visible:outline-2";
export const NAV_ITEM_ACTIVE = "bg-selected font-semibold hover:bg-selected";
// relative lets an app pin a note under the field, as Mail does for a search that's too long.
export const HEADER_SEARCH =
  "relative flex min-w-0 flex-1 items-center gap-2 rounded bg-field pl-2.5 outline-accent has-focus-visible:outline-2 md:max-w-[360px]";

const AVATAR_COLOURS = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
];

const AVATAR_SIZES = {
  regular: "size-8 text-xs",
  small: "size-[22px] text-[9px]",
};

export function Avatar({
  person,
  size = "regular",
}: {
  person: ShellPerson;
  size?: keyof typeof AVATAR_SIZES;
}) {
  const words = person.name.trim().split(/\s+/);
  const initials = (
    (words[0]?.[0] ?? "") + (words.length > 1 ? (words.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
  let sum = 0;
  for (const character of person.email) sum += character.charCodeAt(0);
  return (
    <span
      className={`flex flex-none items-center justify-center rounded-full font-semibold text-on-avatar ${AVATAR_SIZES[size]} ${AVATAR_COLOURS[sum % AVATAR_COLOURS.length]}`}
      aria-hidden
    >
      {initials}
    </span>
  );
}

export function AppShell({
  currentApp,
  apps,
  person,
  accountHref,
  signOutHref,
  navigationLabel,
  navigation,
  sidebarFooter,
  headerContent,
  children,
}: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const personMenu = useId();
  const progress = useNavigationProgress();

  return (
    <div className="flex min-h-dvh bg-page text-text">
      {menuOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-10 cursor-default bg-text opacity-20 md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-20 flex w-56 flex-none flex-col gap-1 overflow-y-auto border-r border-line bg-sidebar p-2.5 md:sticky md:top-0 md:h-dvh ${menuOpen ? "" : "max-md:hidden"}`}
        onClick={(event) => {
          if ((event.target as Element).closest("a")) setMenuOpen(false);
        }}
      >
        <div className="flex items-center gap-2 px-2 pt-1 pb-3 font-semibold">
          <span className="flex size-6 items-center justify-center rounded bg-accent text-on-accent">
            <IconCloud size={15} stroke={2} aria-hidden />
          </span>
          CloudySuite
        </div>
        <nav aria-label="Apps" className="flex flex-col gap-0.5">
          {apps.map((app) => (
            <a
              key={app.id}
              href={app.href}
              aria-current={app.id === currentApp ? "page" : undefined}
              className={`${NAV_ITEM} ${app.id === currentApp ? NAV_ITEM_ACTIVE : ""}`}
            >
              <app.icon size={18} stroke={1.75} aria-hidden />
              {app.name}
            </a>
          ))}
        </nav>
        {navigation && (
          <nav
            aria-label={navigationLabel}
            className="mt-3 flex flex-col gap-0.5"
          >
            {navigationLabel && (
              <h2 className="px-2.5 pb-1 text-xs font-semibold text-secondary">
                {navigationLabel}
              </h2>
            )}
            {navigation}
          </nav>
        )}
        {sidebarFooter && <div className="mt-auto">{sidebarFooter}</div>}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex h-13 flex-none items-center gap-3 border-b border-line px-4">
          <button
            type="button"
            aria-label="Open menu"
            className="cursor-pointer rounded p-1 text-secondary outline-accent focus-visible:outline-2 md:hidden"
            onClick={() => setMenuOpen(true)}
          >
            <IconMenu2 size={22} stroke={1.75} aria-hidden />
          </button>
          {headerContent}
          <button
            type="button"
            popoverTarget={personMenu}
            aria-label={`Account menu for ${person.name}`}
            className="ml-auto cursor-pointer rounded-full outline-accent focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Avatar person={person} />
          </button>
          <div
            id={personMenu}
            popover="auto"
            className="fixed inset-auto top-12 right-3 m-0 w-64 rounded border border-line bg-panel p-1.5 text-text shadow-lg"
          >
            <div className="flex items-center gap-2.5 p-2">
              <Avatar person={person} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{person.name}</p>
                <p className="truncate text-xs text-secondary">
                  {person.email}
                </p>
              </div>
            </div>
            <a href={accountHref} className={NAV_ITEM}>
              <IconUser size={18} stroke={1.75} aria-hidden />
              Your account
            </a>
            <a href={signOutHref} className={NAV_ITEM}>
              <IconLogout size={18} stroke={1.75} aria-hidden />
              Sign out
            </a>
          </div>
          <ProgressBar progress={progress} />
        </header>
        <main
          aria-busy={progress === "slow" || undefined}
          className="min-w-0 flex-1"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
