import { SignIn } from "@cloudysuite/auth";
import { prepareSignIn } from "@cloudysuite/auth/session";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/sign-in")({
  validateSearch: (search): { returnTo?: string } =>
    typeof search.returnTo === "string" ? { returnTo: search.returnTo } : {},
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => prepareSignIn({ data: deps }),
  component: () => <SignIn returnTo={Route.useLoaderData().returnTo} />,
});
