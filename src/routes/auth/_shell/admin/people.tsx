import { PeoplePage } from "@cloudysuite/auth";
import { getPeople } from "@cloudysuite/auth/admin";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/_shell/admin/people")({
  loader: () => getPeople(),
  component: () => <PeoplePage view={Route.useLoaderData()} />,
});
