import { ResetPage } from "@cloudysuite/auth";
import { getResetLink } from "@cloudysuite/auth/welcome";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/reset/$token")({
  loader: ({ params }) => getResetLink({ data: { token: params.token } }),
  component: () => (
    <ResetPage token={Route.useParams().token} reset={Route.useLoaderData()} />
  ),
});
