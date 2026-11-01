import { downloadFile } from "@cloudysuite/storage/download";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/storage/download/$driveId/$itemId")({
  server: {
    handlers: {
      GET: ({ request, params }) => downloadFile(request, params),
    },
  },
});
