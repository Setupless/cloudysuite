import { PeoplePage } from "@cloudysuite/auth";
import { getPeople } from "@cloudysuite/auth/admin";
import { createFileRoute } from "@tanstack/react-router";
import { AdminPending } from "@cloudysuite/auth/pending";

export const Route = createFileRoute("/auth/_shell/admin/people")({
  loader: () => getPeople(),
  component: () => <PeoplePage view={Route.useLoaderData()} />,
  pendingComponent: AdminPending,
});
