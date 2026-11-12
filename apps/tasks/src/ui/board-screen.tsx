import type { BoardId } from "@cloudysuite/access";
import { Notice, useHydrated } from "@cloudysuite/ui";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
} from "@tanstack/react-query";
import { useMemo, useReducer } from "react";
import { boardsQuery, boardTasksQuery, membersQuery } from "../queries";
import type { BoardOfTask, Task, TaskId } from "../types";
import { BROWSING, listReducer } from "./list-state";
import { NewTaskRow } from "./new-task-row";
import { BoardSwatch } from "./parts";
import { canEditWith, TaskPanel } from "./task-panel";
import {
  DoneFold,
  Empty,
  focusRow,
  Loading,
  PageHeading,
  TaskSection,
  useListKeys,
  useMe,
  useToday,
} from "./task-page";
import { boardSections } from "./task-order";
import { TaskRow } from "./task-row";
import { useTaskChanges } from "./use-task-changes";

function Board({ boardId }: { boardId: BoardId }) {
  const me = useMe();
  const today = useToday();
  const listing = useQuery(boardTasksQuery(boardId));
  const entry = useQuery(boardsQuery()).data?.find(
    (board) => board.id === boardId,
  );
  const teamBoard = listing.data?.kind === "team";
  const members = useQuery({ ...membersQuery(boardId), enabled: teamBoard });
  const emails = useMemo(
    () => new Map(members.data?.map((member) => [member.id, member.email])),
    [members.data],
  );
  const changes = useTaskChanges();
  const role = listing.data?.role;
  const canEdit = role ? canEditWith(role) : false;
  const [state, dispatch] = useReducer(listReducer, BROWSING);
  useListKeys(state, dispatch, canEdit);

  const board: BoardOfTask = {
    id: boardId,
    kind: listing.data?.kind ?? "team",
    name: entry?.name ?? "",
    colour: entry?.colour ?? 1,
  };
  const sections = listing.data ? boardSections(listing.data.tasks) : null;
  const openTask =
    state.kind === "open"
      ? listing.data?.tasks.find((task) => task.id === state.taskId)
      : undefined;

  const row = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      place={{ kind: "board", teamBoard, emails }}
      today={today}
      open={state.kind === "open" && state.taskId === task.id}
      canTick={canEdit || task.assignee?.id === me}
      onOpen={() =>
        dispatch(
          state.kind === "open" && state.taskId === task.id
            ? { type: "close" }
            : { type: "open", taskId: task.id },
        )
      }
      onTick={() => void changes.tick(boardId, task)}
    />
  );
  const empty =
    sections &&
    sections.doing.length + sections.todo.length + sections.done.length === 0;

  return (
    <div className="flex min-h-[calc(100dvh-3.25rem)]">
      <div className="min-w-0 flex-1 *:max-w-[912px]">
        <PageHeading
          title={board.kind === "personal" ? "Only you" : board.name}
          swatch={entry && <BoardSwatch colour={entry.colour} />}
          canAdd={role ? canEdit : null}
          onAdd={() => dispatch({ type: "startAdding" })}
        />
        <div
          className="flex flex-col px-4 pb-24"
          aria-busy={listing.isPending || undefined}
        >
          {listing.error && (
            <Notice tone="danger">{listing.error.message}</Notice>
          )}
          {role === "viewer" && (
            <p className="px-1 pb-1 text-sm text-secondary">
              You can view this board. To change its tasks, ask one of its
              managers for Can edit.
            </p>
          )}
          {state.kind === "adding" && (
            <ul className="border-t border-line">
              <NewTaskRow
                today={today}
                members={teamBoard ? (members.data ?? []) : null}
                onAdd={async (draft) =>
                  (await changes.send(boardId, {
                    kind: "create",
                    id: crypto.randomUUID() as TaskId,
                    ...draft,
                  })) !== null
                }
                onCancel={() => dispatch({ type: "close" })}
              />
            </ul>
          )}
          {listing.isPending && <Loading />}
          {empty && state.kind !== "adding" && (
            <Empty>
              {canEdit
                ? "Add the first task with New task."
                : "There are no tasks on this board yet."}
            </Empty>
          )}
          {sections && sections.doing.length > 0 && (
            <TaskSection title="Doing" count={sections.doing.length}>
              {sections.doing.map(row)}
            </TaskSection>
          )}
          {sections && sections.todo.length > 0 && (
            <TaskSection title="To do" count={sections.todo.length}>
              {sections.todo.map(row)}
            </TaskSection>
          )}
          {sections && (
            <DoneFold
              label={`${sections.done.length} done`}
              count={sections.done.length}
            >
              {sections.done.map(row)}
            </DoneFold>
          )}
        </div>
      </div>
      {openTask && state.kind === "open" && role && (
        <TaskPanel
          key={openTask.id}
          task={openTask}
          board={board}
          role={role}
          me={me}
          members={members.data}
          state={state}
          changes={changes}
          onEdit={(field) => dispatch({ type: "edit", field })}
          onDoneEditing={() => dispatch({ type: "stopEditing" })}
          onClose={() => {
            dispatch({ type: "close" });
            focusRow(openTask.id);
          }}
        />
      )}
    </div>
  );
}

function Heading({ boardId }: { boardId: BoardId }) {
  const entry = useQuery(boardsQuery()).data?.find(
    (board) => board.id === boardId,
  );
  return (
    <PageHeading
      title={entry?.name ?? ""}
      swatch={entry && <BoardSwatch colour={entry.colour} />}
      canAdd={null}
      onAdd={() => {}}
    />
  );
}

// The server checks the id, and says so in plain words when it isn't a board.
export function BoardScreen({
  boardId: raw,
  prefetched,
}: {
  boardId: string;
  prefetched: DehydratedState | undefined;
}) {
  const boardId = raw as BoardId;
  const hydrated = useHydrated();
  return (
    <HydrationBoundary state={prefetched}>
      {/* A new board starts with nothing open. */}
      {hydrated ? (
        <Board key={boardId} boardId={boardId} />
      ) : (
        <Heading boardId={boardId} />
      )}
    </HydrationBoundary>
  );
}
