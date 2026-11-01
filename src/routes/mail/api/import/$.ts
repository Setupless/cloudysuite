import { handleImportRequest } from "@cloudysuite/mail/import-api";
import { createFileRoute } from "@tanstack/react-router";

const handle = ({
  request,
  params,
}: {
  request: Request;
  params: { _splat?: string };
}) => handleImportRequest(request, params._splat ?? "");

export const Route = createFileRoute("/mail/api/import/$")({
  server: { handlers: { GET: handle, POST: handle, PUT: handle } },
});
