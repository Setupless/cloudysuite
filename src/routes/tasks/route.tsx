import { TasksLayout, TasksRoot, TasksRouteError } from "@cloudysuite/tasks";
import {
  requireRememberedUser,
  type SignedIn,
} from "@cloudysuite/auth/session";
import { prefetchBoards } from "@cloudysuite/tasks/routes";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks")({
  beforeLoad: async (load): Promise<{ user: SignedIn }> => ({
    user: await requireRememberedUser("tasks", load),
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
