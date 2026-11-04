import { NoMailbox } from "@cloudysuite/mail";
import { redirectToFirstMailbox } from "@cloudysuite/mail/routes";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/")({
  loader: () => redirectToFirstMailbox(),
  component: () => <NoMailbox user={Route.useRouteContext().user} />,
});
