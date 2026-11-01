import { handleComposeRequest } from "@cloudysuite/mail/compose-api";
import { createFileRoute } from "@tanstack/react-router";

const handle = ({
  request,
  params,
}: {
  request: Request;
  params: { _splat?: string };
}) => handleComposeRequest(request, params._splat ?? "");

export const Route = createFileRoute("/mail/api/compose/$")({
  server: { handlers: { PUT: handle, POST: handle } },
});
