import { NoMailbox } from "@cloudysuite/mail";
import { firstMailbox } from "@cloudysuite/mail/functions";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/")({
  loader: async () => {
    const mailboxId = await firstMailbox();
    if (mailboxId) {
      throw redirect({
        to: "/mail/$mailboxId/$view",
        params: { mailboxId, view: "inbox" },
      });
    }
  },
  component: () => <NoMailbox user={Route.useRouteContext().user} />,
});
