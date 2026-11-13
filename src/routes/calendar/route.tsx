import {
  CalendarLayout,
  CalendarRoot,
  CalendarRouteError,
} from "@cloudysuite/calendar";
import {
  requireRememberedUser,
  type SignedIn,
} from "@cloudysuite/auth/session";
import { prefetchCalendars } from "@cloudysuite/calendar/routes";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/calendar")({
  beforeLoad: async (load): Promise<{ user: SignedIn }> => ({
    user: await requireRememberedUser("calendar", load),
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
