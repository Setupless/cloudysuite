import { HomeScreen } from "@cloudysuite/storage";
import { prefetchHome } from "@cloudysuite/storage/routes";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/storage/")({
  loader: () => prefetchHome(),
  component: () => (
    <HomeScreen
      prefetched={Route.useLoaderData()}
      mailHref={Route.useRouteContext().user.apps.mail}
    />
  ),
});
