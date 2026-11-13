import { MailViewScreen } from "@cloudysuite/mail";
import { prefetchThreads } from "@cloudysuite/mail/routes";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ViewPending } from "@cloudysuite/mail/pending";

export const Route = createFileRoute("/mail/$mailboxId/$view")({
  // The router reads a hand-typed ?q=2026 as a number.
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" || typeof search.q === "number"
      ? { q: String(search.q) }
      : { q: undefined },
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
  pendingComponent: ViewPending,
});
