import { AppShell, type ShellApp } from "@cloudysuite/ui";
import {
  IconCalendar,
  IconChecklist,
  IconFolder,
  IconMail,
  IconUserCircle,
} from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { AppId } from "../../../src/routing";
import type { SignedIn } from "./session";

const APP_DISPLAY: Record<AppId, { name: string; icon: Icon }> = {
  mail: { name: "Mail", icon: IconMail },
  storage: { name: "Storage", icon: IconFolder },
  calendar: { name: "Calendar", icon: IconCalendar },
  tasks: { name: "Tasks", icon: IconChecklist },
  auth: { name: "Account", icon: IconUserCircle },
};

// The shell for a signed-in page. Pass it what `requireUser` returned.
export function SuiteShell({
  app,
  user,
  navigationLabel,
  navigation,
  sidebarFooter,
  headerContent,
  signOutHref,
  children,
}: {
  app: AppId;
  user: SignedIn;
  navigationLabel?: string;
  navigation?: ReactNode;
  sidebarFooter?: ReactNode;
  headerContent?: ReactNode;
  // Mail's offline stand-in, because Account can't load without a connection.
  signOutHref?: string;
  children: ReactNode;
}) {
  const apps: ShellApp[] = [];
  for (const [id, display] of Object.entries(APP_DISPLAY)) {
    const href = user.apps[id as AppId];
    if (href) apps.push({ id, href, ...display });
  }
  // Auth can never be turned off, so this address always exists.
  const account = user.apps.auth as string;
  return (
    <AppShell
      currentApp={app}
      apps={apps}
      person={user}
      accountHref={account}
      signOutHref={signOutHref ?? new URL("/sign-out", account).href}
      navigationLabel={navigationLabel}
      navigation={navigation}
      sidebarFooter={sidebarFooter}
      headerContent={headerContent}
    >
      {children}
    </AppShell>
  );
}
