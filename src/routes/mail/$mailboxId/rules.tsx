import { RulesPage } from "@cloudysuite/mail";
import { prefetchRules } from "@cloudysuite/mail/routes";
import { createFileRoute } from "@tanstack/react-router";
import { SettingsPending } from "@cloudysuite/mail/pending";

export const Route = createFileRoute("/mail/$mailboxId/rules")({
  loader: ({ params }) => prefetchRules(params.mailboxId),
  component: () => (
    <RulesPage
      mailboxId={Route.useParams().mailboxId}
      prefetched={Route.useLoaderData()}
    />
  ),
  pendingComponent: SettingsPending,
});
