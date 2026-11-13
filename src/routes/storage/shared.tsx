import { SharedScreen } from "@cloudysuite/storage";
import { prefetchShared } from "@cloudysuite/storage/routes";
import { createFileRoute } from "@tanstack/react-router";
import { SharedPending } from "@cloudysuite/storage/pending";

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
  pendingComponent: SharedPending,
});
