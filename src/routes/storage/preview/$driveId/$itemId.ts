import { previewFile } from "@cloudysuite/storage/download";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/storage/preview/$driveId/$itemId")({
  server: {
    handlers: {
      GET: ({ request, params }) => previewFile(request, params),
    },
  },
});
