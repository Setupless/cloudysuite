import { MailRoot, requireMailUser } from "@cloudysuite/mail";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/mail")({
  beforeLoad: async ({ location }) => ({
    user: await requireMailUser(location),
  }),
  component: () => (
    <MailRoot>
      <Outlet />
    </MailRoot>
  ),
});
