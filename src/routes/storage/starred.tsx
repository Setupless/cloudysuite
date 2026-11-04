import { StarredScreen } from "@cloudysuite/storage";
import { prefetchStarred } from "@cloudysuite/storage/routes";
import { createFileRoute } from "@tanstack/react-router";

const validateSearch = (search: Record<string, unknown>): { file?: string } =>
  typeof search.file === "string" ? { file: search.file } : {};

export const Route = createFileRoute("/storage/starred")({
  validateSearch,
  loader: () => prefetchStarred(),
  component: () => (
    <StarredScreen
      me={Route.useRouteContext().user}
      file={Route.useSearch().file}
      prefetched={Route.useLoaderData()}
    />
  ),
});
