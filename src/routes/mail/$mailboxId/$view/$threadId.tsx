import { ThreadPane } from "@cloudysuite/mail";
import { createFileRoute } from "@tanstack/react-router";
import { ThreadPending } from "@cloudysuite/mail/pending";

export const Route = createFileRoute("/mail/$mailboxId/$view/$threadId")({
  component: () => <ThreadPane threadParam={Route.useParams().threadId} />,
  pendingComponent: ThreadPending,
});
