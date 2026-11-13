import { AuthRouteError, AuthShell } from "@cloudysuite/auth";
import { requireAuthUser, type SignedIn } from "@cloudysuite/auth/session";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/_shell")({
  beforeLoad: async (load): Promise<{ user: SignedIn }> => ({
    user: await requireAuthUser(load),
  }),
  errorComponent: AuthRouteError,
  component: () => (
    <AuthShell user={Route.useRouteContext().user}>
      <Outlet />
    </AuthShell>
  ),
});
