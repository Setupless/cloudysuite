import { NAV_ITEM, NAV_ITEM_ACTIVE } from "@cloudysuite/ui";
import { IconUser } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { SignedIn } from "./session";
import { SuiteShell } from "./shell";

export function AuthShell({
  user,
  children,
}: {
  user: SignedIn;
  children: ReactNode;
}) {
  return (
    <SuiteShell
      app="auth"
      user={user}
      navigation={
        <Link
          to="/auth"
          activeOptions={{ exact: true }}
          className={NAV_ITEM}
          activeProps={{ className: NAV_ITEM_ACTIVE }}
        >
          <IconUser size={18} stroke={1.75} aria-hidden />
          Your account
        </Link>
      }
    >
      {children}
    </SuiteShell>
  );
}
