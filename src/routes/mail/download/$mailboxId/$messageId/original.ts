import { downloadOriginal } from "@cloudysuite/mail/download";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/mail/download/$mailboxId/$messageId/original",
)({
  server: {
    handlers: {
      GET: ({ request, params }) => downloadOriginal(request, params),
    },
  },
});
