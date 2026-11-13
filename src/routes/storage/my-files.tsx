import { MyFilesScreen } from "@cloudysuite/storage";
import { redirectToMyDrive } from "@cloudysuite/storage/routes";
import { createFileRoute } from "@tanstack/react-router";
import { FolderPending } from "@cloudysuite/storage/pending";

export const Route = createFileRoute("/storage/my-files")({
  loader: () => redirectToMyDrive(),
  component: () => <MyFilesScreen me={Route.useRouteContext().user} />,
  pendingComponent: FolderPending,
});
