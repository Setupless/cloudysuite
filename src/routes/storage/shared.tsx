import { prefetchShared, SharedScreen } from "@cloudysuite/storage";
import { createFileRoute } from "@tanstack/react-router";

const validateSearch = (search: Record<string, unknown>): { file?: string } =>
  typeof search.file === "string" ? { file: search.file } : {};

export const Route = createFileRoute("/storage/shared")({
  validateSearch,
  loader: () => prefetchShared(),
  component: () => (
    <SharedScreen
      me={Route.useRouteContext().user}
      file={Route.useSearch().file}
      prefetched={Route.useLoaderData()}
    />
  ),
});
