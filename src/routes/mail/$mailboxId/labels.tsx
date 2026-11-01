import { LabelsPage } from "@cloudysuite/mail";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/$mailboxId/labels")({
  component: () => <LabelsPage mailboxId={Route.useParams().mailboxId} />,
});
