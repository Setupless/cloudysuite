import { AuthHome } from "@cloudysuite/auth";
import { requireUser } from "@cloudysuite/auth/session";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/")({
  beforeLoad: async ({ location }) => ({
    user: await requireUser("auth", location),
  }),
  component: () => <AuthHome user={Route.useRouteContext().user} />,
});
