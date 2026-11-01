import { requireAdmin } from "@cloudysuite/auth/session";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/_shell/admin")({
  beforeLoad: async ({ location }) => {
    await requireAdmin(location);
  },
});
