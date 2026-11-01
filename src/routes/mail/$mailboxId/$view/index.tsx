import { NoThreadOpen } from "@cloudysuite/mail";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/$mailboxId/$view/")({
  component: NoThreadOpen,
});
