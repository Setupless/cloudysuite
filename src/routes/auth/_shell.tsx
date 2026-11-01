import { AuthShell } from "@cloudysuite/auth";
import { requireUser } from "@cloudysuite/auth/session";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/_shell")({
  beforeLoad: async ({ location }) => ({
    user: await requireUser("auth", location),
  }),
  component: () => (
    <AuthShell user={Route.useRouteContext().user}>
      <Outlet />
    </AuthShell>
  ),
});
