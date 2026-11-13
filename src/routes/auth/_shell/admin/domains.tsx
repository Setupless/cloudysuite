import { DomainsPage } from "@cloudysuite/auth";
import { getDomains } from "@cloudysuite/auth/admin";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/_shell/admin/domains")({
  validateSearch: (search): { adding?: string } =>
    typeof search.adding === "string" ? { adding: search.adding } : {},
  loader: () => getDomains(),
  component: () => (
    <DomainsPage
      view={Route.useLoaderData()}
      adding={Route.useSearch().adding ?? null}
    />
  ),
});
