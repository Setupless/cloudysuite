import { RecentScreen } from "@cloudysuite/storage";
import { prefetchRecent } from "@cloudysuite/storage/routes";
import { createFileRoute } from "@tanstack/react-router";
import { RecentPending } from "@cloudysuite/storage/pending";

const validateSearch = (search: Record<string, unknown>): { file?: string } =>
  typeof search.file === "string" ? { file: search.file } : {};

export const Route = createFileRoute("/storage/recent")({
  validateSearch,
  loader: () => prefetchRecent(),
  component: () => (
    <RecentScreen
      me={Route.useRouteContext().user}
      file={Route.useSearch().file}
      prefetched={Route.useLoaderData()}
    />
  ),
  pendingComponent: RecentPending,
});
