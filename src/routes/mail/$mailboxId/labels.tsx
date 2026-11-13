import { LabelsPage } from "@cloudysuite/mail";
import { createFileRoute } from "@tanstack/react-router";
import { SettingsPending } from "@cloudysuite/mail/pending";

export const Route = createFileRoute("/mail/$mailboxId/labels")({
  component: () => <LabelsPage mailboxId={Route.useParams().mailboxId} />,
  pendingComponent: SettingsPending,
});
