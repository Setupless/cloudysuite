import { handleUploadRequest } from "@cloudysuite/storage/api";
import { createFileRoute } from "@tanstack/react-router";

const handle = ({
  request,
  params,
}: {
  request: Request;
  params: { _splat?: string };
}) => handleUploadRequest(request, params._splat ?? "");

export const Route = createFileRoute("/storage/api/drives/$")({
  server: { handlers: { POST: handle, PUT: handle } },
});
