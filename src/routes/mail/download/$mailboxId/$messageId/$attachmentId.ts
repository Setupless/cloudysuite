import { downloadAttachment } from "@cloudysuite/mail/download";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/mail/download/$mailboxId/$messageId/$attachmentId",
)({
  server: {
    handlers: {
      GET: ({ request, params }) => downloadAttachment(request, params),
    },
  },
});
