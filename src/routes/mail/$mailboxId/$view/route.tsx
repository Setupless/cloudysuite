import { MailViewScreen, prefetchThreads } from "@cloudysuite/mail";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/$mailboxId/$view")({
  loader: ({ params }) => prefetchThreads(params.mailboxId, params.view),
  component: () => {
    const { mailboxId, view } = Route.useParams();
    return (
      <MailViewScreen
        mailboxId={mailboxId}
        viewRaw={view}
        prefetched={Route.useLoaderData()}
      >
        <Outlet />
      </MailViewScreen>
    );
  },
});
