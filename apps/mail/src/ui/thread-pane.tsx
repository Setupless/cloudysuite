import { IconArrowLeft } from "@tabler/icons-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  FOLDER_DISPLAY,
  listingSearchParams,
  parseThreadParam,
  viewParam,
} from "../model";
import {
  isRefusal,
  mailKeys,
  REFRESH_MS,
  threadOfMessageQuery,
  threadQuery,
} from "../queries";
import {
  labelsOnThread,
  liveFolders,
  type MessageId,
  type ThreadId,
} from "../types";
import { useMailView } from "./mail-view-context";
import { MessageCard } from "./message-card";
import { FailureNotice } from "./states";
import { LabelChip, useLabels } from "./label-chip";
import {
  LabelButton,
  MoveButtons,
  ReadButton,
  StarButton,
} from "./thread-actions";

function BackToList() {
  const { mailboxId, view } = useMailView();
  return (
    <Link
      to="/mail/$mailboxId/$view"
      params={{ mailboxId, view: viewParam(view) }}
      search={listingSearchParams(view)}
      className="flex size-8 flex-none items-center justify-center rounded text-secondary outline-accent hover:bg-field focus-visible:outline-2 lg:hidden"
      aria-label="Back to the list"
    >
      <IconArrowLeft size={20} stroke={1.75} aria-hidden />
    </Link>
  );
}

function ThreadGone() {
  const { mailboxId, view } = useMailView();
  const place =
    "folder" in view ? FOLDER_DISPLAY[view.folder].title : "the list";
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm">
      <p className="max-w-xs text-secondary">
        This conversation isn't here anymore. It may have been deleted or joined
        to another conversation.
      </p>
      <Link
        to="/mail/$mailboxId/$view"
        params={{ mailboxId, view: viewParam(view) }}
        search={listingSearchParams(view)}
        className="text-accent underline outline-accent focus-visible:outline-2"
      >
        Back to {place}
      </Link>
    </div>
  );
}

function ThreadView({ threadId }: { threadId: ThreadId }) {
  const {
    mailboxId,
    view,
    commands,
    movesOf,
    act,
    closeThread,
    labelCommands,
    openLabels,
  } = useMailView();
  const labels = useLabels(mailboxId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const thread = useQuery({
    ...threadQuery(mailboxId, threadId),
    refetchInterval: () => (queryClient.isMutating() ? false : REFRESH_MS),
  });
  const detail = thread.data;

  // A merge deletes this thread's row. Its messages survive, and the last one we
  // saw knows where they went.
  const lastSeenMessage = useRef<MessageId | null>(null);
  const lastMessage = detail?.messages.at(-1)?.id;
  if (lastMessage) lastSeenMessage.current = lastMessage;
  const gone = thread.isSuccess && detail === null;
  const moved = useQuery({
    ...threadOfMessageQuery(
      mailboxId,
      lastSeenMessage.current ?? (0 as MessageId),
    ),
    enabled: gone && lastSeenMessage.current !== null,
  });
  const movedTo = moved.data;

  useEffect(() => {
    if (!gone) return;
    void queryClient.invalidateQueries({
      queryKey: mailKeys.threads(mailboxId),
    });
    if (!movedTo) return;
    void navigate({
      to: "/mail/$mailboxId/$view/$threadId",
      params: { mailboxId, view: viewParam(view), threadId: String(movedTo) },
      search: listingSearchParams(view),
      replace: true,
    });
  }, [gone, movedTo, navigate, queryClient, mailboxId, view]);

  // Once per opening, so a colleague marking it unread later is not undone here.
  const markedRead = useRef(false);
  const hasUnread = detail?.messages.some((message) => !message.read) ?? false;
  useEffect(() => {
    if (!detail || markedRead.current) return;
    markedRead.current = true;
    if (hasUnread) commands.setRead(threadId, true);
  }, [detail, hasUnread, commands, threadId]);

  const [overrides, setOverrides] = useState<ReadonlyMap<MessageId, boolean>>(
    new Map(),
  );
  // Stays open after opening marks it read: the reader came here for this message.
  const firstSeen = useRef(new Map<MessageId, boolean>());
  for (const message of detail?.messages ?? []) {
    if (!firstSeen.current.has(message.id)) {
      firstSeen.current.set(message.id, !message.read);
    }
  }

  if (
    thread.isPending ||
    (gone && lastSeenMessage.current && moved.isPending)
  ) {
    return (
      <div aria-hidden className="flex animate-pulse flex-col gap-3 px-6 py-5">
        <div className="h-5 w-1/2 rounded bg-field" />
        <div className="h-3 w-4/5 rounded bg-field" />
        <div className="h-3 w-3/5 rounded bg-field" />
      </div>
    );
  }
  if (thread.isError) {
    return (
      <FailureNotice
        message={thread.error.message}
        onRetry={
          isRefusal(thread.error) ? undefined : () => void thread.refetch()
        }
      />
    );
  }
  if (!detail) return <ThreadGone />;

  const starred = detail.messages.some((message) => message.starred);
  const subject = detail.messages[0]?.subject?.trim() || "(No subject)";
  const applied = labelsOnThread(detail);
  return (
    <div className="flex flex-col gap-1 px-4 py-3 lg:px-6">
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-0.5 bg-panel py-1">
        <BackToList />
        <ReadButton
          unread={hasUnread}
          onToggle={() => {
            commands.setRead(threadId, hasUnread);
            if (!hasUnread) closeThread();
          }}
        />
        <StarButton
          starred={starred}
          onToggle={() => commands.setStarred(threadId, !starred)}
        />
        <LabelButton onClick={() => openLabels(threadId)} />
        <MoveButtons
          moves={movesOf(
            liveFolders(detail.messages.map((message) => message.folder)),
          )}
          onMove={(move) => act(threadId, move)}
        />
      </div>
      <h1 className="pb-2 text-[22px] leading-tight font-semibold break-words">
        {subject}
      </h1>
      {labels.some((label) => applied.includes(label.id)) && (
        <div className="flex flex-wrap gap-1.5 pb-2">
          {labels
            .filter((label) => applied.includes(label.id))
            .map((label) => (
              <LabelChip
                key={label.id}
                label={label}
                onRemove={() =>
                  labelCommands.setApplied(threadId, label.id, false)
                }
              />
            ))}
        </div>
      )}
      {detail.messages.map((message, index) => {
        const isLatest = index === detail.messages.length - 1;
        const open =
          overrides.get(message.id) ??
          (isLatest || firstSeen.current.get(message.id) === true);
        return (
          <MessageCard
            key={message.id}
            message={message}
            open={open}
            onToggle={() =>
              setOverrides(new Map(overrides).set(message.id, !open))
            }
          />
        );
      })}
    </div>
  );
}

export function ThreadPane({ threadParam }: { threadParam: string }) {
  const threadId = parseThreadParam(threadParam);
  if (threadId === null) return <ThreadGone />;
  return <ThreadView key={threadId} threadId={threadId} />;
}

export function NoThreadOpen() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-secondary max-lg:hidden">
      Choose a conversation to read it here.
    </div>
  );
}
