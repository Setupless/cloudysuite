import { Notice, useHydrated } from "@cloudysuite/ui";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
} from "@tanstack/react-query";
import { useReducer } from "react";
import { boardsQuery, membersQuery, myTasksQuery } from "../queries";
import type { BoardRole } from "@cloudysuite/access";
import type { MyTask, TaskId } from "../types";
import { dayOnDevice, longDayText } from "./dates";
import { BROWSING, listReducer } from "./list-state";
import { NewTaskRow } from "./new-task-row";
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
import { MY_GROUP_TITLES, planMyTasks } from "./task-order";
import { TaskRow } from "./task-row";
import { useTaskChanges } from "./use-task-changes";

const unreachableText = (count: number) =>
  `We couldn't reach ${count === 1 ? "one of your boards" : `${count} of your boards`}, so some tasks may be missing. Try again in a moment.`;

// A team task's panel offers that board's people.
function MinePanel({
  task,
  ...rest
}: Omit<Parameters<typeof TaskPanel>[0], "members" | "board"> & {
  task: MyTask;
}) {
  const members = useQuery({
    ...membersQuery(task.board.id),
    enabled: task.board.kind === "team",
  });
  return (
    <TaskPanel
      task={task}
      board={task.board}
      members={members.data}
      {...rest}
    />
  );
}

function MyTasks() {
  const me = useMe();
  const today = useToday();
  const mine = useQuery(myTasksQuery());
  const boards = useQuery(boardsQuery());
  const changes = useTaskChanges();
  const [state, dispatch] = useReducer(listReducer, BROWSING);
  useListKeys(state, dispatch, true);

  const roleOn = (task: MyTask): BoardRole =>
    task.board.kind === "personal"
      ? "manager"
      : (boards.data?.find((board) => board.id === task.board.id)?.role ??
        "viewer");
  const openTask =
    state.kind === "open"
      ? mine.data?.tasks.find((task) => task.id === state.taskId)
      : undefined;
  const plan = mine.data
    ? planMyTasks(mine.data.tasks, me, today, dayOnDevice)
    : null;
  const close = (taskId: TaskId) => {
    dispatch({ type: "close" });
    focusRow(taskId);
  };

  const row = (task: MyTask) => (
    <TaskRow
      key={task.id}
      task={task}
      place={{ kind: "mine", board: task.board }}
      today={today}
      open={state.kind === "open" && state.taskId === task.id}
      canTick={canEditWith(roleOn(task)) || task.assignee?.id === me}
      onOpen={() =>
        dispatch(
          state.kind === "open" && state.taskId === task.id
            ? { type: "close" }
            : { type: "open", taskId: task.id },
        )
      }
      onTick={() => void changes.tick(task.board.id, task)}
    />
  );

  return (
    <div className="flex min-h-[calc(100dvh-3.25rem)]">
      <div className="min-w-0 flex-1 *:max-w-[912px]">
        <PageHeading
          title="My tasks"
          detail={longDayText(today)}
          canAdd
          onAdd={() => dispatch({ type: "startAdding" })}
        />
        <div className="px-4 pb-24" aria-busy={mine.isPending || undefined}>
          {mine.error && <Notice tone="danger">{mine.error.message}</Notice>}
          {mine.data && mine.data.unreachable > 0 && (
            <Notice tone="info">
              {unreachableText(mine.data.unreachable)}
            </Notice>
          )}
          {state.kind === "adding" && (
            <ul className="border-t border-line">
              <NewTaskRow
                today={today}
                members={null}
                onAdd={(draft) =>
                  changes.addPrivate({
                    id: crypto.randomUUID() as TaskId,
                    title: draft.title,
                    due: draft.due,
                  })
                }
                onCancel={() => dispatch({ type: "close" })}
              />
            </ul>
          )}
          {mine.isPending && <Loading />}
          {plan && plan.groups.length === 0 && state.kind !== "adding" && (
            <Empty>
              Nothing assigned to you. Tasks you add here are only for you.
            </Empty>
          )}
          {plan?.groups.map(({ group, tasks }) => (
            <TaskSection
              key={group}
              title={MY_GROUP_TITLES[group]}
              tone={group === "overdue" ? "danger" : "plain"}
              count={tasks.length}
            >
              {tasks.map(row)}
            </TaskSection>
          ))}
          {plan && (
            <DoneFold
              label={`${plan.doneToday.length} done today`}
              count={plan.doneToday.length}
            >
              {plan.doneToday.map(row)}
            </DoneFold>
          )}
        </div>
      </div>
      {openTask && state.kind === "open" && (
        <MinePanel
          key={openTask.id}
          task={openTask}
          role={roleOn(openTask)}
          me={me}
          state={state}
          changes={changes}
          onEdit={(field) => dispatch({ type: "edit", field })}
          onDoneEditing={() => dispatch({ type: "stopEditing" })}
          onClose={() => close(openTask.id)}
        />
      )}
    </div>
  );
}

export function MyTasksScreen({
  prefetched,
}: {
  prefetched: DehydratedState | undefined;
}) {
  // The groups follow the device's own day, which the server doesn't know, so the list
  // waits for the browser. Its tasks are already here by then.
  const hydrated = useHydrated();
  return (
    <HydrationBoundary state={prefetched}>
      {hydrated ? (
        <MyTasks />
      ) : (
        <PageHeading title="My tasks" canAdd={null} onAdd={() => {}} />
      )}
    </HydrationBoundary>
  );
}
