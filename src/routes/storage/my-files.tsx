import { MyFilesScreen, redirectToMyDrive } from "@cloudysuite/storage";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/storage/my-files")({
  loader: () => redirectToMyDrive(),
  component: () => <MyFilesScreen me={Route.useRouteContext().user} />,
});
