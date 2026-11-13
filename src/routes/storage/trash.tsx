import { TrashScreen } from "@cloudysuite/storage";
import { prefetchTrash } from "@cloudysuite/storage/routes";
import { createFileRoute } from "@tanstack/react-router";
import { TrashPending } from "@cloudysuite/storage/pending";

export const Route = createFileRoute("/storage/trash")({
  loader: () => prefetchTrash(),
  component: () => <TrashScreen prefetched={Route.useLoaderData()} />,
  pendingComponent: TrashPending,
});
