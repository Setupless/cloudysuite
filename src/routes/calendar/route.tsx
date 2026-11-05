import {
  CalendarLayout,
  CalendarRoot,
  CalendarRouteError,
} from "@cloudysuite/calendar";
import {
  prefetchCalendars,
  requireCalendarUser,
} from "@cloudysuite/calendar/routes";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/calendar")({
  beforeLoad: async ({ location }) => ({
    user: await requireCalendarUser(location),
  }),
  loader: () => prefetchCalendars(),
  errorComponent: CalendarRouteError,
  component: () => (
    <CalendarRoot>
      <CalendarLayout
        user={Route.useRouteContext().user}
        prefetched={Route.useLoaderData()}
      >
        <Outlet />
      </CalendarLayout>
    </CalendarRoot>
  ),
});
