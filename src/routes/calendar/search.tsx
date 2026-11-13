import { SearchScreen } from "@cloudysuite/calendar";
import { createFileRoute } from "@tanstack/react-router";
import { SearchPending } from "@cloudysuite/calendar/pending";

const validateSearch = (search: Record<string, unknown>): { q?: string } =>
  typeof search.q === "string" ? { q: search.q } : {};

export const Route = createFileRoute("/calendar/search")({
  validateSearch,
  component: () => <SearchScreen text={Route.useSearch().q ?? ""} />,
  pendingComponent: SearchPending,
});
