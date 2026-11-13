import { BoardScreen } from "@cloudysuite/tasks";
import { prefetchBoard, validateBoardSearch } from "@cloudysuite/tasks/routes";
import { createFileRoute } from "@tanstack/react-router";
import { BoardPending } from "@cloudysuite/tasks/pending";

export const Route = createFileRoute("/tasks/boards/$boardId")({
  validateSearch: validateBoardSearch,
  loader: ({ params }) => prefetchBoard(params.boardId),
  component: () => {
    const { task, person } = Route.useSearch();
    return (
      <BoardScreen
        boardId={Route.useParams().boardId}
        task={task}
        person={person}
        prefetched={Route.useLoaderData()}
      />
    );
  },
  pendingComponent: BoardPending,
});
