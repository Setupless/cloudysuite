import { PersonScreen } from "@cloudysuite/tasks";
import { createFileRoute } from "@tanstack/react-router";
import { BoardPending } from "@cloudysuite/tasks/pending";

export const Route = createFileRoute("/tasks/people/$userId")({
  component: () => <PersonScreen userId={Route.useParams().userId} />,
  pendingComponent: BoardPending,
});
