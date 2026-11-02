import { FileScreen, prefetchFile } from "@cloudysuite/storage";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/storage/file/$driveId/$fileId")({
  loader: ({ params }) => prefetchFile(params.driveId, params.fileId),
  component: () => {
    const { driveId, fileId } = Route.useParams();
    return (
      <FileScreen
        me={Route.useRouteContext().user}
        driveId={driveId}
        fileId={fileId}
        prefetched={Route.useLoaderData()}
      />
    );
  },
});
