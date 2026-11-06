import { OverviewScreen } from "@cloudysuite/calendar";
import { prefetchOverview } from "@cloudysuite/calendar/routes";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/calendar/")({
  loader: () => prefetchOverview(),
  component: () => <OverviewScreen prefetched={Route.useLoaderData()} />,
});
