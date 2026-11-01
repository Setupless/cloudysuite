import { OrganisationPage } from "@cloudysuite/auth";
import { getOrganisation } from "@cloudysuite/auth/admin";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/_shell/admin/")({
  loader: () => getOrganisation(),
  component: () => <OrganisationPage view={Route.useLoaderData()} />,
});
