import { TodayScreen } from "@cloudysuite/calendar";
import { prefetchToday } from "@cloudysuite/calendar/routes";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/calendar/")({
  loader: () => prefetchToday(),
  component: () => <TodayScreen prefetched={Route.useLoaderData()} />,
});
