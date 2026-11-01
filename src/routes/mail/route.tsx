import {
  MailRoot,
  MailRouteError,
  mailHead,
  requireMailUser,
} from "@cloudysuite/mail";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/mail")({
  head: () => mailHead(),
  beforeLoad: async ({ location }) => ({
    user: await requireMailUser(location),
  }),
  errorComponent: ({ error }) => <MailRouteError error={error} />,
  component: () => (
    <MailRoot user={Route.useRouteContext().user}>
      <Outlet />
    </MailRoot>
  ),
});
