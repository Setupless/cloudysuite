import { SuiteShell } from "@cloudysuite/auth/shell";
import {
  getManagedMailboxes,
  ImportNavigation,
  ImportPage,
} from "@cloudysuite/mail/import";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/import")({
  validateSearch: (search: Record<string, unknown>) => ({
    mailbox: typeof search.mailbox === "string" ? search.mailbox : undefined,
  }),
  loader: () => getManagedMailboxes(),
  component: () => (
    <SuiteShell
      app="mail"
      user={Route.useRouteContext().user}
      navigationLabel="Mail"
      navigation={<ImportNavigation />}
    >
      <ImportPage
        mailboxes={Route.useLoaderData()}
        preferredMailboxId={Route.useSearch().mailbox}
      />
    </SuiteShell>
  ),
});
