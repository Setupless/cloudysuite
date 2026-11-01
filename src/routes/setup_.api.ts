import { handleSetupRoute } from "@cloudysuite/auth/setup/route";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/setup_/api")({
  server: {
    handlers: {
      POST: ({ request }) => handleSetupRoute(request),
    },
  },
});
