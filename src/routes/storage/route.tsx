import {
  StorageLayout,
  StorageRoot,
  StorageRouteError,
} from "@cloudysuite/storage";
import {
  prefetchDirectory,
  requireStorageUser,
} from "@cloudysuite/storage/routes";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/storage")({
  beforeLoad: async ({ location }) => ({
    user: await requireStorageUser(location),
  }),
  loader: () => prefetchDirectory(),
  errorComponent: StorageRouteError,
  component: () => (
    <StorageRoot>
      <StorageLayout
        user={Route.useRouteContext().user}
        prefetched={Route.useLoaderData()}
      >
        <Outlet />
      </StorageLayout>
    </StorageRoot>
  ),
});
