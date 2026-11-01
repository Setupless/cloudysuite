import { MailViewScreen, prefetchThreads } from "@cloudysuite/mail";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/$mailboxId/$view")({
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" ? { q: search.q } : {},
  loader: ({ params }) => prefetchThreads(params.mailboxId, params.view),
  component: () => {
    const { mailboxId, view } = Route.useParams();
    return (
      <MailViewScreen
        mailboxId={mailboxId}
        viewRaw={view}
        q={Route.useSearch().q}
        prefetched={Route.useLoaderData()}
      >
        <Outlet />
      </MailViewScreen>
    );
  },
});
