import { AuthRouteError, AuthShell } from "@cloudysuite/auth";
import {
  requireRememberedUser,
  type SignedIn,
} from "@cloudysuite/auth/session";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/_shell")({
  beforeLoad: async (load): Promise<{ user: SignedIn }> => ({
    user: await requireRememberedUser("auth", load),
  }),
  errorComponent: AuthRouteError,
  component: () => (
    <AuthShell user={Route.useRouteContext().user}>
      <Outlet />
    </AuthShell>
  ),
});
