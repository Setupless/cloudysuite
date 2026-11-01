import { requireUser } from "@cloudysuite/auth/session";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail")({
  beforeLoad: async ({ location }) => ({
    user: await requireUser("mail", location),
  }),
});
