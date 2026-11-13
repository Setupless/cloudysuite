import { OverviewScreen } from "@cloudysuite/calendar";
import { prefetchOverview } from "@cloudysuite/calendar/routes";
import { createFileRoute } from "@tanstack/react-router";
import { OverviewPending } from "@cloudysuite/calendar/pending";

export const Route = createFileRoute("/calendar/")({
  loader: () => prefetchOverview(),
  component: () => <OverviewScreen prefetched={Route.useLoaderData()} />,
  pendingComponent: OverviewPending,
});
