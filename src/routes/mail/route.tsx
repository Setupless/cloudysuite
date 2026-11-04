import { MailRoot, MailRouteError } from "@cloudysuite/mail";
import { mailHead, requireMailUser } from "@cloudysuite/mail/routes";
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
