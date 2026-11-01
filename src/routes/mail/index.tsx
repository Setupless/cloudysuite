import { NoMailbox, redirectToFirstMailbox } from "@cloudysuite/mail";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/")({
  loader: () => redirectToFirstMailbox(),
  component: () => <NoMailbox user={Route.useRouteContext().user} />,
});
