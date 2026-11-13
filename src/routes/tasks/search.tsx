import { SearchScreen } from "@cloudysuite/tasks";
import { validateSearchPage } from "@cloudysuite/tasks/routes";
import { createFileRoute } from "@tanstack/react-router";
import { SearchPending } from "@cloudysuite/tasks/pending";

export const Route = createFileRoute("/tasks/search")({
  validateSearch: validateSearchPage,
  component: () => {
    const { q, board } = Route.useSearch();
    return <SearchScreen text={q ?? ""} board={board} />;
  },
  pendingComponent: SearchPending,
});
