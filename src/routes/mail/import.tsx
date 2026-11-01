import { SuiteShell } from "@cloudysuite/auth/shell";
import {
  getManagedMailboxes,
  ImportNavigation,
  ImportPage,
} from "@cloudysuite/mail/import";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/import")({
  loader: () => getManagedMailboxes(),
  component: () => (
    <SuiteShell
      app="mail"
      user={Route.useRouteContext().user}
      navigationLabel="Mail"
      navigation={<ImportNavigation />}
    >
      <ImportPage mailboxes={Route.useLoaderData()} />
    </SuiteShell>
  ),
});
