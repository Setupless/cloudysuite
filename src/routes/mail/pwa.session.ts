import { deviceSessionResponse } from "@cloudysuite/mail/device-session";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/pwa/session")({
  server: {
    handlers: { GET: ({ request }) => deviceSessionResponse(request) },
  },
});
