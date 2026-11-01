import { Button, Modal } from "@cloudysuite/ui";
import { IconKeyboard } from "@tabler/icons-react";
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  type DehydratedState,
  HydrationBoundary,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  FOLDER_DISPLAY,
  type MoveId,
  movesFor,
  parseThreadParam,
  parseViewParam,
  viewParam,
} from "../model";
import {
  isRefusal,
  mailboxesQuery,
  mailKeys,
  REFRESH_MS,
  threadsQuery,
} from "../queries";
import { threadsIn } from "../thread-cache";
import type {
  MailboxId,
  ThreadDetail,
  ThreadId,
  ThreadSummary,
  ThreadView,
} from "../types";
import { useThreadCommands } from "./commands";
import { MailViewContext } from "./mail-view-context";
import { FailureNotice, SkeletonLines } from "./states";
import { IconButton } from "./thread-actions";
import { LoadMore, ThreadRows } from "./thread-list";

const SHORTCUTS: [string, string][] = [
  ["j", "Next conversation"],
  ["k", "Previous conversation"],
  ["Enter", "Open the conversation"],
  ["e", "Archive"],
  ["#", "Move to Trash"],
  ["s", "Add or remove star"],
  ["u", "Mark as read or unread"],
  ["?", "Show these shortcuts"],
];

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
        {SHORTCUTS.map(([key, description]) => (
          <div key={key} className="col-span-2 grid grid-cols-subgrid">
            <dt>
              <kbd className="rounded border border-line bg-field px-1.5 py-0.5 font-mono text-xs">
                {key}
              </kbd>
            </dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
      <div className="flex justify-end">
        <Button variant="quiet" autoFocus onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

function ConfirmDelete({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title="Delete this conversation forever?" onClose={onCancel}>
      <p className="text-sm text-secondary">
        You can't get it back after this.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="quiet" autoFocus onClick={onCancel}>
          Keep it
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Delete forever
        </Button>
      </div>
    </Modal>
  );
}

function neighbourOf(threads: ThreadSummary[], threadId: ThreadId) {
  const index = threads.findIndex((thread) => thread.id === threadId);
  if (index < 0) return null;
  return threads[index + 1]?.id ?? threads[index - 1]?.id ?? null;
}

function MailView({
  mailboxId,
  view,
  children,
}: {
  mailboxId: MailboxId;
  view: ThreadView;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const openThreadId = parseThreadParam(params.threadId ?? "");

  const list = useInfiniteQuery({
    ...threadsQuery(mailboxId, view),
    refetchInterval: () => (queryClient.isMutating() ? false : REFRESH_MS),
  });
  const threads = useMemo(() => threadsIn(list.data), [list.data]);
  const mailboxes = useQuery(mailboxesQuery());
  const summary = mailboxes.data?.find(
    (mailbox) => mailbox.id === mailboxId,
  )?.summary;

  const folder = "folder" in view ? view.folder : null;
  const label =
    "labelId" in view
      ? summary?.labels.find((one) => one.id === view.labelId)
      : undefined;
  const title = folder
    ? FOLDER_DISPLAY[folder].title
    : (label?.name ?? "Label");
  const showsUnread = folder ? FOLDER_DISPLAY[folder].countsUnread : true;
  const unread = folder ? summary?.folderUnread[folder] : label?.unread;

  const commands = useThreadCommands(mailboxId, view);
  const moves = movesFor(view);
  const [focusedId, setFocusedId] = useState<ThreadId | null>(openThreadId);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<ThreadId | null>(
    null,
  );

  useEffect(() => {
    if (openThreadId !== null) setFocusedId(openThreadId);
  }, [openThreadId]);

  const closeThread = useCallback(() => {
    void navigate({
      to: "/mail/$mailboxId/$view",
      params: { mailboxId, view: viewParam(view) },
    });
  }, [navigate, mailboxId, view]);

  const moveAway = (threadId: ThreadId, move: MoveId) => {
    if (!folder) return;
    const next = neighbourOf(threads, threadId);
    commands.move(threadId, folder, move);
    setFocusedId(next);
    if (threadId === openThreadId) closeThread();
  };

  const act = (threadId: ThreadId, move: MoveId) => {
    if (move === "deleteForever") setConfirmingDelete(threadId);
    else moveAway(threadId, move);
  };

  const step = (direction: 1 | -1) => {
    const index = threads.findIndex((thread) => thread.id === focusedId);
    const next = threads[index === -1 ? 0 : index + direction];
    if (next) setFocusedId(next.id);
    if (index + direction >= threads.length - 5 && list.hasNextPage) {
      void list.fetchNextPage();
    }
  };

  const target = focusedId ?? openThreadId;
  const targetState = () => {
    if (target === null) return null;
    const row = threads.find((thread) => thread.id === target);
    if (row) return { unread: row.unreadCount > 0, starred: row.starred };
    const detail = queryClient.getQueryData<ThreadDetail | null>(
      mailKeys.thread(mailboxId, target),
    );
    if (!detail) return null;
    return {
      unread: detail.messages.some((message) => !message.read),
      starred: detail.messages.some((message) => message.starred),
    };
  };
  const moveTarget = (move: MoveId) => {
    if (target !== null && moves.includes(move)) moveAway(target, move);
  };

  const hotkeysOn = !helpOpen && confirmingDelete === null;
  const hotkeys = { enabled: hotkeysOn };
  useHotkey("J", () => step(1), hotkeys);
  useHotkey("K", () => step(-1), hotkeys);
  useHotkey(
    "Enter",
    () => {
      if (focusedId === null) return;
      void navigate({
        to: "/mail/$mailboxId/$view/$threadId",
        params: {
          mailboxId,
          view: viewParam(view),
          threadId: String(focusedId),
        },
      });
    },
    hotkeys,
  );
  useHotkey("E", () => moveTarget("archive"), hotkeys);
  useHotkey("#", () => moveTarget("trash"), hotkeys);
  useHotkey(
    "S",
    () => {
      const state = targetState();
      if (state && target !== null) commands.setStarred(target, !state.starred);
    },
    hotkeys,
  );
  useHotkey(
    "U",
    () => {
      const state = targetState();
      if (!state || target === null) return;
      commands.setRead(target, state.unread);
      if (!state.unread && target === openThreadId) closeThread();
    },
    hotkeys,
  );
  useHotkey("?", () => setHelpOpen(true), hotkeys);

  const context = {
    mailboxId,
    view,
    commands,
    moves,
    act,
    closeThread,
  };

  let listBody: ReactNode;
  if (list.isPending) {
    listBody = <SkeletonLines rows={9} />;
  } else if (list.isError) {
    listBody = (
      <FailureNotice
        message={list.error.message}
        onRetry={isRefusal(list.error) ? undefined : () => void list.refetch()}
      />
    );
  } else if (threads.length === 0) {
    listBody = (
      <p className="px-6 py-12 text-center text-sm text-secondary">
        {folder ? FOLDER_DISPLAY[folder].empty : "Nothing has this label yet."}
      </p>
    );
  } else {
    listBody = (
      <>
        <ThreadRows
          threads={threads}
          openThreadId={openThreadId}
          focusedId={focusedId}
        />
        {list.hasNextPage && (
          <LoadMore
            loading={list.isFetchingNextPage}
            failed={list.isFetchNextPageError}
            onLoad={() => {
              if (!list.isFetchingNextPage) void list.fetchNextPage();
            }}
          />
        )}
      </>
    );
  }

  return (
    <MailViewContext.Provider value={context}>
      <div className="flex h-[calc(100dvh-3.25rem)] min-w-0">
        <section
          aria-label={title}
          className={`min-w-0 flex-1 flex-col border-line lg:flex lg:w-[370px] lg:flex-none lg:border-r ${openThreadId === null ? "flex" : "max-lg:hidden"}`}
        >
          <header className="flex flex-none items-baseline gap-3 px-4 pt-3.5 pb-2.5">
            <h1 className="min-w-0 flex-1 truncate text-[21px] font-semibold">
              {title}
            </h1>
            {showsUnread && (unread ?? 0) > 0 && (
              <span className="flex-none text-xs text-secondary">
                {unread} unread
              </span>
            )}
            <span className="self-center max-lg:hidden">
              <IconButton
                icon={IconKeyboard}
                label="Keyboard shortcuts"
                onClick={() => setHelpOpen(true)}
              />
            </span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">{listBody}</div>
        </section>
        <section
          key={openThreadId ?? "none"}
          aria-label="Conversation"
          className={`min-w-0 flex-1 overflow-y-auto bg-panel ${openThreadId === null ? "max-lg:hidden" : ""}`}
        >
          {children}
        </section>
      </div>
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
      {confirmingDelete !== null && (
        <ConfirmDelete
          onCancel={() => setConfirmingDelete(null)}
          onConfirm={() => {
            moveAway(confirmingDelete, "deleteForever");
            setConfirmingDelete(null);
          }}
        />
      )}
    </MailViewContext.Provider>
  );
}

export function MailViewScreen({
  mailboxId,
  viewRaw,
  prefetched,
  children,
}: {
  mailboxId: string;
  viewRaw: string;
  prefetched: DehydratedState | undefined;
  children: ReactNode;
}) {
  const view = useMemo(() => parseViewParam(viewRaw), [viewRaw]);
  if (!view) {
    return (
      <FailureNotice message="We couldn't find that folder. Choose one from the menu." />
    );
  }
  return (
    <HydrationBoundary state={prefetched}>
      <MailView key={viewRaw} mailboxId={mailboxId as MailboxId} view={view}>
        {children}
      </MailView>
    </HydrationBoundary>
  );
}
