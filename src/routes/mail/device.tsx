import { DevicePage } from "@cloudysuite/mail";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/mail/device")({
  component: () => <DevicePage user={Route.useRouteContext().user} />,
});
