import { prefetchSearch, SearchScreen } from "@cloudysuite/storage";
import { createFileRoute } from "@tanstack/react-router";

const validateSearch = (search: Record<string, unknown>): { q?: string } =>
  typeof search.q === "string" ? { q: search.q } : {};

export const Route = createFileRoute("/storage/search")({
  validateSearch,
  loaderDeps: ({ search }) => ({ q: search.q ?? "" }),
  loader: ({ deps }) => prefetchSearch(deps.q),
  component: () => (
    <SearchScreen
      text={Route.useSearch().q ?? ""}
      prefetched={Route.useLoaderData()}
    />
  ),
});
