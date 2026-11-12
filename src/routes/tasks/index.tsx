import { MyTasksScreen } from "@cloudysuite/tasks";
import { prefetchMyTasks } from "@cloudysuite/tasks/routes";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks/")({
  loader: () => prefetchMyTasks(),
  component: () => <MyTasksScreen prefetched={Route.useLoaderData()} />,
});
