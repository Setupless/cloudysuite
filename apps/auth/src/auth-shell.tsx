import { NAV_ITEM, NAV_ITEM_ACTIVE } from "@cloudysuite/ui";
import {
  IconAt,
  IconBuilding,
  IconUser,
  IconUsers,
  IconWorld,
} from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { SignedIn } from "./session";
import { SuiteShell } from "./shell";

const ADMIN_LINKS: { to: string; label: string; icon: Icon }[] = [
  { to: "/auth/admin/people", label: "People", icon: IconUsers },
  { to: "/auth/admin/mailboxes", label: "Email addresses", icon: IconAt },
  { to: "/auth/admin/domains", label: "Email domains", icon: IconWorld },
  { to: "/auth/admin", label: "Organisation", icon: IconBuilding },
];

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
        <>
          <Link
            to="/auth"
            activeOptions={{ exact: true }}
            className={NAV_ITEM}
            activeProps={{ className: NAV_ITEM_ACTIVE }}
          >
            <IconUser size={18} stroke={1.75} aria-hidden />
            Your account
          </Link>
          {user.role === "admin" && (
            <>
              <h2 className="px-2.5 pt-3 pb-1 text-xs font-semibold text-secondary">
                Admin
              </h2>
              {ADMIN_LINKS.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  activeOptions={{ exact: true }}
                  className={NAV_ITEM}
                  activeProps={{ className: NAV_ITEM_ACTIVE }}
                >
                  <link.icon size={18} stroke={1.75} aria-hidden />
                  {link.label}
                </Link>
              ))}
            </>
          )}
        </>
      }
    >
      {children}
    </SuiteShell>
  );
}
