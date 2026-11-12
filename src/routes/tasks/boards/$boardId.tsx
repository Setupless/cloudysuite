import { BoardScreen } from "@cloudysuite/tasks";
import { prefetchBoard } from "@cloudysuite/tasks/routes";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks/boards/$boardId")({
  loader: ({ params }) => prefetchBoard(params.boardId),
  component: () => (
    <BoardScreen
      boardId={Route.useParams().boardId}
      prefetched={Route.useLoaderData()}
    />
  ),
});
