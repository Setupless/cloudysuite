import { EnrolPage } from "@cloudysuite/auth";
import { prepareEnrol } from "@cloudysuite/auth/account";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/enrol")({
  validateSearch: (search): { returnTo?: string } =>
    typeof search.returnTo === "string" ? { returnTo: search.returnTo } : {},
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => prepareEnrol({ data: deps }),
  component: () => (
    <EnrolPage
      returnTo={Route.useLoaderData().returnTo}
      signOutHref="/sign-out"
    />
  ),
});
