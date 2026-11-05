import { ScheduleScreen } from "@cloudysuite/calendar";
import {
  parseScheduleSearch,
  prefetchSchedule,
} from "@cloudysuite/calendar/routes";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/calendar/schedule")({
  validateSearch: parseScheduleSearch,
  loaderDeps: ({ search }) => ({ view: search.view, date: search.date }),
  loader: ({ deps }) => prefetchSchedule(deps),
  component: () => (
    <ScheduleScreen
      search={Route.useSearch()}
      prefetched={Route.useLoaderData()}
    />
  ),
});
