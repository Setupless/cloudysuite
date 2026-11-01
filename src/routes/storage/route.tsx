import {
  prefetchDirectory,
  requireStorageUser,
  StorageLayout,
  StorageRoot,
} from "@cloudysuite/storage";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/storage")({
  beforeLoad: async ({ location }) => ({
    user: await requireStorageUser(location),
  }),
  loader: () => prefetchDirectory(),
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
