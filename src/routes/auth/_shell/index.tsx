import { AccountPage } from "@cloudysuite/auth";
import { getAccount } from "@cloudysuite/auth/account";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/_shell/")({
  loader: () => getAccount(),
  component: () => (
    <AccountPage
      person={Route.useRouteContext().user}
      account={Route.useLoaderData()}
    />
  ),
});
