import { FolderScreen, prefetchFolder } from "@cloudysuite/storage";
import { createFileRoute } from "@tanstack/react-router";

const validateSearch = (search: Record<string, unknown>): { file?: string } =>
  typeof search.file === "string" ? { file: search.file } : {};

export const Route = createFileRoute("/storage/drive/$driveId/")({
  validateSearch,
  loader: ({ params }) => prefetchFolder(params.driveId),
  component: () => (
    <FolderScreen
      me={Route.useRouteContext().user}
      driveId={Route.useParams().driveId}
      file={Route.useSearch().file}
      prefetched={Route.useLoaderData()}
    />
  ),
});
