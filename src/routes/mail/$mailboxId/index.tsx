import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/$mailboxId/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/mail/$mailboxId/$view",
      params: { mailboxId: params.mailboxId, view: "inbox" },
    });
  },
});
