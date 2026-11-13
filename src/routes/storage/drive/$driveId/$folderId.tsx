import { FolderScreen } from "@cloudysuite/storage";
import { prefetchFolder } from "@cloudysuite/storage/routes";
import { createFileRoute } from "@tanstack/react-router";
import { FolderPending } from "@cloudysuite/storage/pending";

const validateSearch = (search: Record<string, unknown>): { file?: string } =>
  typeof search.file === "string" ? { file: search.file } : {};

export const Route = createFileRoute("/storage/drive/$driveId/$folderId")({
  validateSearch,
  loader: ({ params }) => prefetchFolder(params.driveId, params.folderId),
  component: () => {
    const { driveId, folderId } = Route.useParams();
    return (
      <FolderScreen
        me={Route.useRouteContext().user}
        driveId={driveId}
        folderId={folderId}
        file={Route.useSearch().file}
        prefetched={Route.useLoaderData()}
      />
    );
  },
  pendingComponent: FolderPending,
});
