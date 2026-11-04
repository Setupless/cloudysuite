import { MailboxLayout } from "@cloudysuite/mail";
import { prefetchMailboxes } from "@cloudysuite/mail/routes";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/$mailboxId")({
  loader: () => prefetchMailboxes(),
  component: () => (
    <MailboxLayout
      user={Route.useRouteContext().user}
      mailboxId={Route.useParams().mailboxId}
      prefetched={Route.useLoaderData()}
    >
      <Outlet />
    </MailboxLayout>
  ),
});
