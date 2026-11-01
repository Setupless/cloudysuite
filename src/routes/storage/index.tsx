import { HomeScreen, prefetchHome } from "@cloudysuite/storage";
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
