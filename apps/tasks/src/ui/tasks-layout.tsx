import type { BoardId, UserId } from "@cloudysuite/access";
import type { SignedIn } from "@cloudysuite/auth/session";
import { SuiteShell } from "@cloudysuite/auth/shell";
import { NameDialog, NAV_ITEM, NAV_ITEM_ACTIVE } from "@cloudysuite/ui";
import { IconDots, IconHome, IconPlus } from "@tabler/icons-react";
import { PrefetchedData } from "@cloudysuite/page-data";
import {
  type DehydratedState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { createTeamBoard } from "../functions";
import { boardsQuery, call, tasksKeys } from "../queries";
import type { BoardEntry } from "../types";
import { BoardSettingsDialog } from "./board-settings";
import { BoardSwatch } from "./parts";
import { SearchBox } from "./search-box";
import { MeProvider } from "./task-page";

const itemClass = (active: boolean) =>
  `${NAV_ITEM} ${active ? NAV_ITEM_ACTIVE : ""}`;

function Navigation({
  boards,
  onSettings,
  onNewBoard,
}: {
  boards: BoardEntry[] | undefined;
  onSettings: (boardId: BoardId) => void;
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
        // Shown on hover or focus, on the board that's open, and always on a device that
        // can't hover, such as a phone.
        const shown = active
          ? "pr-9"
          : "group-focus-within:pr-9 group-hover:pr-9 [@media(hover:none)]:pr-9";
        return (
          <div key={board.id} className="group relative">
            <Link
              to="/tasks/boards/$boardId"
              params={{ boardId: board.id }}
              aria-current={active ? "page" : undefined}
              className={`${itemClass(active)} ${shown}`}
            >
              <span className="flex size-[18px] flex-none items-center justify-center">
                <BoardSwatch colour={board.colour} />
              </span>
              <span className="min-w-0 truncate" dir="auto">
                {board.name}
              </span>
            </Link>
            <button
              type="button"
              aria-label={`Settings for ${board.name}`}
              className={`absolute top-1/2 right-1 flex -translate-y-1/2 cursor-pointer rounded p-1 text-secondary outline-accent group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-panel hover:text-text focus-visible:outline-2 [@media(hover:none)]:opacity-100 ${active ? "" : "opacity-0"}`}
              onClick={() => onSettings(board.id)}
            >
              <IconDots size={16} stroke={1.75} aria-hidden />
            </button>
          </div>
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
  const { pathname } = useLocation();
  const { data: boards } = useQuery(boardsQuery());
  const [naming, setNaming] = useState(false);
  const [settingsFor, setSettingsFor] = useState<BoardId | null>(null);
  // Gone from the list once it's deleted or left, which closes its settings.
  const settingsEntry = boards?.find((board) => board.id === settingsFor);
  return (
    <SuiteShell
      app="tasks"
      user={user}
      navigationLabel="Tasks"
      headerContent={<SearchBox ready={boards !== undefined} />}
      navigation={
        <Navigation
          boards={boards}
          onSettings={setSettingsFor}
          onNewBoard={() => setNaming(true)}
        />
      }
    >
      {children}
      {settingsEntry && (
        <BoardSettingsDialog
          key={settingsEntry.id}
          entry={settingsEntry}
          meId={user.id as UserId}
          onClose={() => setSettingsFor(null)}
          onGone={async () => {
            const path = pathname.replace(/\/$/, "");
            if (path.endsWith(`/boards/${settingsEntry.id}`)) {
              await navigate({ to: "/tasks" });
            }
          }}
        />
      )}
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
    <PrefetchedData state={prefetched}>
      <MeProvider id={user.id as UserId}>
        <Shell user={user}>{children}</Shell>
      </MeProvider>
    </PrefetchedData>
  );
}
