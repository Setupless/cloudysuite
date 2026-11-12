import type { UserId } from "@cloudysuite/access";
import type { SignedIn } from "@cloudysuite/auth/session";
import { SuiteShell } from "@cloudysuite/auth/shell";
import { NameDialog, NAV_ITEM, NAV_ITEM_ACTIVE } from "@cloudysuite/ui";
import { IconHome, IconPlus } from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { createTeamBoard } from "../functions";
import { boardsQuery, call, tasksKeys } from "../queries";
import type { BoardEntry } from "../types";
import { BoardSwatch } from "./parts";
import { MeProvider } from "./task-page";

const itemClass = (active: boolean) =>
  `${NAV_ITEM} ${active ? NAV_ITEM_ACTIVE : ""}`;

function Navigation({
  boards,
  onNewBoard,
}: {
  boards: BoardEntry[] | undefined;
  onNewBoard: () => void;
}) {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/$/, "");
  return (
    <>
      <Link
        to="/tasks"
        activeOptions={{ exact: true }}
        className={itemClass(["", "/tasks"].includes(path))}
      >
        <IconHome size={18} stroke={1.75} aria-hidden />
        My tasks
      </Link>
      <h3 className="px-2.5 pt-3 pb-1 text-xs font-semibold text-secondary">
        Team boards
      </h3>
      {boards?.map((board) => {
        const active = path.endsWith(`/boards/${board.id}`);
        return (
          <Link
            key={board.id}
            to="/tasks/boards/$boardId"
            params={{ boardId: board.id }}
            aria-current={active ? "page" : undefined}
            className={itemClass(active)}
          >
            <span className="flex size-[18px] flex-none items-center justify-center">
              <BoardSwatch colour={board.colour} />
            </span>
            <span className="min-w-0 truncate" dir="auto">
              {board.name}
            </span>
          </Link>
        );
      })}
      <button
        type="button"
        className={`${NAV_ITEM} cursor-pointer`}
        onClick={onNewBoard}
      >
        <span className="flex items-center gap-2.5 text-secondary">
          <IconPlus size={18} stroke={1.75} aria-hidden />
          New team board
        </span>
      </button>
    </>
  );
}

function Shell({ user, children }: { user: SignedIn; children: ReactNode }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: boards } = useQuery(boardsQuery());
  const [naming, setNaming] = useState(false);
  return (
    <SuiteShell
      app="tasks"
      user={user}
      navigationLabel="Tasks"
      navigation={
        <Navigation boards={boards} onNewBoard={() => setNaming(true)} />
      }
    >
      {children}
      {naming && (
        <NameDialog
          title="New team board"
          hint="A place for your team's tasks. You'll be its manager."
          submitLabel="Create team board"
          onSubmit={async (name) => {
            const boardId = await call(() =>
              createTeamBoard({ data: { name } }),
            );
            await client.invalidateQueries({ queryKey: tasksKeys.boards });
            await navigate({
              to: "/tasks/boards/$boardId",
              params: { boardId },
            });
          }}
          onClose={() => setNaming(false)}
        />
      )}
    </SuiteShell>
  );
}

export function TasksLayout({
  user,
  prefetched,
  children,
}: {
  user: SignedIn;
  prefetched: DehydratedState | undefined;
  children: ReactNode;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <MeProvider id={user.id as UserId}>
        <Shell user={user}>{children}</Shell>
      </MeProvider>
    </HydrationBoundary>
  );
}
