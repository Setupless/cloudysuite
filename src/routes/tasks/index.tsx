import { MyTasksScreen } from "@cloudysuite/tasks";
import { prefetchMyTasks, validateTaskSearch } from "@cloudysuite/tasks/routes";
import { createFileRoute } from "@tanstack/react-router";
import { MyTasksPending } from "@cloudysuite/tasks/pending";

export const Route = createFileRoute("/tasks/")({
  validateSearch: validateTaskSearch,
  loader: () => prefetchMyTasks(),
  component: () => (
    <MyTasksScreen
      task={Route.useSearch().task}
      prefetched={Route.useLoaderData()}
    />
  ),
  pendingComponent: MyTasksPending,
});
