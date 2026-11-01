import { handleAuthRequest } from "@cloudysuite/auth/handler";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request),
      POST: ({ request }) => handleAuthRequest(request),
    },
  },
});
