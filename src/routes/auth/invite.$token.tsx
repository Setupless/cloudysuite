import { InvitePage } from "@cloudysuite/auth";
import { getInvite } from "@cloudysuite/auth/welcome";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/invite/$token")({
  loader: ({ params }) => getInvite({ data: { token: params.token } }),
  component: () => (
    <InvitePage
      token={Route.useParams().token}
      invite={Route.useLoaderData()}
    />
  ),
});
