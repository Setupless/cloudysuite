import {
  requireRememberedUser,
  type SignedIn,
} from "@cloudysuite/auth/session";
import {
  StorageLayout,
  StorageRoot,
  StorageRouteError,
} from "@cloudysuite/storage";
import { prefetchDirectory } from "@cloudysuite/storage/routes";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/storage")({
  beforeLoad: async (load): Promise<{ user: SignedIn }> => ({
    user: await requireRememberedUser("storage", load),
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
