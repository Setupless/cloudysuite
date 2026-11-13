import { PersonScreen } from "@cloudysuite/tasks";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks/people/$userId")({
  component: () => <PersonScreen userId={Route.useParams().userId} />,
});
