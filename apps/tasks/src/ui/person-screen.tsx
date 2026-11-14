import type { UserId } from "@cloudysuite/access";
import { Avatar, Notice, useHydrated } from "@cloudysuite/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { boardsQuery, personTasksQuery } from "../queries";
import type { TaskHit } from "../types";
import { firstNameOf } from "./assignee-choices";
import { canEditWith } from "./parts";
import {
  Empty,
  Loading,
  PageHeading,
  TaskSection,
  useMe,
  useToday,
} from "./task-page";
import { dueGroups, MY_GROUP_TITLES } from "./task-order";
import { TaskRow } from "./task-row";
import { useTaskChanges } from "./use-task-changes";

const unreachableText = (count: number) =>
  `We couldn't reach ${count === 1 ? "one of the boards you share" : `${count} of the boards you share`}, so some tasks may be missing. Try again in a moment.`;

// Someone's open tasks on the boards the viewer shares with them. A task opens on its
// board, with its panel.
function PersonTasks({ userId }: { userId: UserId }) {
  const me = useMe();
  const today = useToday();
  const navigate = useNavigate();
  const listing = useQuery(personTasksQuery(userId));
  const boards = useQuery(boardsQuery());
  const changes = useTaskChanges();
  const person = listing.data?.person;
  const groups = listing.data ? dueGroups(listing.data.tasks, today) : null;

  const canTick = (task: TaskHit) => {
    const role = boards.data?.find((board) => board.id === task.board.id)?.role;
    return (role ? canEditWith(role) : false) || task.assignee?.id === me;
  };
  const row = (task: TaskHit) => (
    <TaskRow
      key={task.id}
      task={task}
      place={{ kind: "mine", board: task.board }}
      today={today}
      me={me}
      open={false}
      canTick={canTick(task)}
      onOpen={() =>
        void navigate({
          to: "/tasks/boards/$boardId",
          params: { boardId: task.board.id },
          search: { task: task.id },
        })
      }
      onTick={() => void changes.tick(task.board.id, task)}
    />
  );

  return (
    <div className="min-h-[calc(100dvh-3.25rem)] *:max-w-[912px]">
      <PageHeading
        title={person?.name ?? ""}
        swatch={person && <Avatar person={person} size="small" />}
        detail={person && "Open tasks on the boards you share"}
        canAdd={null}
        onAdd={() => {}}
      />
      <div className="px-4 pb-24" aria-busy={listing.isPending || undefined}>
        {listing.error && (
          <Notice tone="danger">{listing.error.message}</Notice>
        )}
        {listing.data && listing.data.unreachable > 0 && (
          <Notice tone="info">
            {unreachableText(listing.data.unreachable)}
          </Notice>
        )}
        {listing.isPending && <Loading />}
        {person && groups?.length === 0 && (
          <Empty>
            {firstNameOf(person.name)} has no open tasks on the boards you
            share.
          </Empty>
        )}
        {groups?.map(({ group, tasks }) => (
          <TaskSection
            key={group}
            title={MY_GROUP_TITLES[group]}
            tone={group === "overdue" ? "danger" : "plain"}
          >
            {tasks.map(row)}
          </TaskSection>
        ))}
      </div>
    </div>
  );
}

export function PersonScreen({ userId }: { userId: string }) {
  // Overdue and Today follow the device's own day.
  const hydrated = useHydrated();
  return hydrated ? (
    <PersonTasks userId={userId as UserId} />
  ) : (
    <PageHeading title="" canAdd={null} onAdd={() => {}} />
  );
}
