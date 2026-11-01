import { Avatar } from "@cloudysuite/ui";
import { IconPaperclip } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { listingSearchParams, viewParam } from "../model";
import { threadQuery } from "../queries";
import type { ThreadId, ThreadSummary } from "../types";
import { displayName, sendersLine } from "./format";
import { useMailView } from "./mail-view-context";
import { ThreadDate } from "./states";
import { RowLabels, useLabels } from "./label-chip";
import {
  LabelButton,
  MoveButtons,
  ReadButton,
  StarButton,
} from "./thread-actions";

// Long enough that a pointer crossing the list does not read every row it passes.
const HOVER_PREFETCH_MS = 120;

function ThreadRow({
  thread,
  open,
  focused,
}: {
  thread: ThreadSummary;
  open: boolean;
  focused: boolean;
}) {
  const { mailboxId, view, commands, movesOf, act, openLabels } = useMailView();
  const labels = useLabels(mailboxId);
  const queryClient = useQueryClient();
  // Only the row under the pointer holds these, so a long list stays light.
  const [hovered, setHovered] = useState(false);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unread = thread.unreadCount > 0;
  const sender = thread.senders[0];
  const quietMoves = movesOf(thread.folders).filter(
    (move) => move !== "deleteForever",
  );

  return (
    <li
      data-thread-id={thread.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative mx-2 rounded [contain-intrinsic-size:auto_78px] [content-visibility:auto] ${open ? "bg-selected" : "hover:bg-field"} ${focused && !open ? "outline-2 -outline-offset-2 outline-accent" : ""}`}
    >
      <Link
        to="/mail/$mailboxId/$view/$threadId"
        params={{
          mailboxId,
          view: viewParam(view),
          threadId: String(thread.id),
        }}
        search={listingSearchParams(view)}
        aria-current={open ? "true" : undefined}
        onMouseEnter={() => {
          prefetchTimer.current = setTimeout(
            () =>
              void queryClient.prefetchQuery(threadQuery(mailboxId, thread.id)),
            HOVER_PREFETCH_MS,
          );
        }}
        onMouseLeave={() => clearTimeout(prefetchTimer.current)}
        className="flex gap-2.5 rounded px-2.5 py-2.5 outline-accent focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <Avatar
          person={{
            name: displayName(sender ?? null),
            email: sender?.address ?? "",
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {unread && (
              <span
                className="size-2 flex-none self-center rounded-full bg-accent"
                aria-label="Unread"
                role="img"
              />
            )}
            <span
              className={`min-w-0 flex-1 truncate text-sm ${unread ? "font-semibold" : ""}`}
            >
              {sendersLine(thread.senders)}
              {thread.messageCount > 1 && (
                <span className="ml-1.5 text-xs font-normal text-secondary">
                  {thread.messageCount}
                </span>
              )}
            </span>
            <ThreadDate timestamp={thread.lastMessageAt} />
          </div>
          <p className={`truncate text-sm ${unread ? "font-semibold" : ""}`}>
            {thread.subject?.trim() || "(No subject)"}
          </p>
          <p className="flex items-center gap-1.5 pr-8 text-[13px] text-secondary">
            <RowLabels labels={labels} labelIds={thread.labelIds} />
            <span className="min-w-0 flex-1 truncate">{thread.snippet}</span>
            {thread.hasAttachments && (
              <IconPaperclip
                size={14}
                stroke={1.75}
                className="flex-none"
                aria-label="Has attachments"
              />
            )}
          </p>
        </div>
      </Link>
      <div className="absolute right-1.5 bottom-1">
        <StarButton
          starred={thread.starred}
          onToggle={() => commands.setStarred(thread.id, !thread.starred)}
        />
      </div>
      {hovered && (
        <div className="absolute top-1 right-1.5 hidden rounded bg-inherit lg:flex">
          <ReadButton
            unread={unread}
            onToggle={() => commands.setRead(thread.id, unread)}
          />
          <LabelButton onClick={() => openLabels(thread.id)} />
          <MoveButtons
            moves={quietMoves}
            onMove={(move) => act(thread.id, move)}
          />
        </div>
      )}
    </li>
  );
}

export function ThreadRows({
  threads,
  openThreadId,
  focusedId,
}: {
  threads: ThreadSummary[];
  openThreadId: ThreadId | null;
  focusedId: ThreadId | null;
}) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (focusedId === null) return;
    list.current
      ?.querySelector(`[data-thread-id="${focusedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focusedId]);

  return (
    <ul ref={list} className="flex flex-col gap-px">
      {threads.map((thread) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          open={thread.id === openThreadId}
          focused={thread.id === focusedId}
        />
      ))}
    </ul>
  );
}

// Loads the next page before the reader reaches the end, so paging never shows.
export function LoadMore({
  loading,
  failed,
  onLoad,
}: {
  loading: boolean;
  failed: boolean;
  onLoad: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const latest = useRef(onLoad);
  latest.current = onLoad;
  useEffect(() => {
    if (!sentinel.current || failed) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: "600px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [failed]);

  return (
    <div
      ref={sentinel}
      className="px-4 py-3 text-center text-sm text-secondary"
    >
      {failed ? (
        <button
          type="button"
          onClick={onLoad}
          className="cursor-pointer text-accent outline-accent focus-visible:outline-2"
        >
          We couldn't load more. Try again
        </button>
      ) : (
        loading && "Loading more…"
      )}
    </div>
  );
}
