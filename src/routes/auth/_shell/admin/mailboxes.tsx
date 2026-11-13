import { MailboxesPage } from "@cloudysuite/auth";
import { getMailboxes } from "@cloudysuite/auth/admin";
import { createFileRoute } from "@tanstack/react-router";
import { AdminPending } from "@cloudysuite/auth/pending";

export const Route = createFileRoute("/auth/_shell/admin/mailboxes")({
  loader: () => getMailboxes(),
  component: () => <MailboxesPage view={Route.useLoaderData()} />,
  pendingComponent: AdminPending,
});
