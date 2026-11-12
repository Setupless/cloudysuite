import { BoardScreen } from "@cloudysuite/tasks";
import { prefetchBoard, validateTaskSearch } from "@cloudysuite/tasks/routes";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks/boards/$boardId")({
  validateSearch: validateTaskSearch,
  loader: ({ params }) => prefetchBoard(params.boardId),
  component: () => (
    <BoardScreen
      boardId={Route.useParams().boardId}
      task={Route.useSearch().task}
      prefetched={Route.useLoaderData()}
    />
  ),
});
