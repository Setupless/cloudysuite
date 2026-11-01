import { prefetchSenders, SendersPage } from "@cloudysuite/mail";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/$mailboxId/senders")({
  loader: ({ params }) => prefetchSenders(params.mailboxId),
  component: () => (
    <SendersPage
      mailboxId={Route.useParams().mailboxId}
      prefetched={Route.useLoaderData()}
    />
  ),
});
