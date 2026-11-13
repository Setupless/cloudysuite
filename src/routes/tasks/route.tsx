import { TasksLayout, TasksRoot, TasksRouteError } from "@cloudysuite/tasks";
import { prefetchBoards, requireTasksUser } from "@cloudysuite/tasks/routes";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks")({
  beforeLoad: async ({ location }) => ({
    user: await requireTasksUser(location),
  }),
  loader: () => prefetchBoards(),
  errorComponent: TasksRouteError,
  component: () => (
    <TasksRoot>
      <TasksLayout
        user={Route.useRouteContext().user}
        prefetched={Route.useLoaderData()}
      >
        <Outlet />
      </TasksLayout>
    </TasksRoot>
  ),
});
