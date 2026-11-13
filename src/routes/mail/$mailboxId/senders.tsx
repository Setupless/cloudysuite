import { SendersPage } from "@cloudysuite/mail";
import { prefetchSenders } from "@cloudysuite/mail/routes";
import { createFileRoute } from "@tanstack/react-router";
import { SettingsPending } from "@cloudysuite/mail/pending";

export const Route = createFileRoute("/mail/$mailboxId/senders")({
  loader: ({ params }) => prefetchSenders(params.mailboxId),
  component: () => (
    <SendersPage
      mailboxId={Route.useParams().mailboxId}
      prefetched={Route.useLoaderData()}
    />
  ),
  pendingComponent: SettingsPending,
});
