import type { InfiniteData } from "@tanstack/react-query";
import type { MailboxEntry } from "./functions";
import { MOVE_DISPLAY, type MoveId } from "./model";
import type {
  Folder,
  LabelId,
  MailboxId,
  MessageFlags,
  ThreadDetail,
  ThreadId,
  ThreadPage,
  ThreadSummary,
  ThreadView,
} from "./types";

export type ThreadPages = InfiniteData<ThreadPage, string | undefined>;

export const threadsIn = (
  pages: InfiniteData<ThreadPage, unknown> | undefined,
): ThreadSummary[] => pages?.pages.flatMap((page) => page.threads) ?? [];

function mapPages(
  pages: ThreadPages,
  change: (threads: ThreadSummary[]) => ThreadSummary[],
): ThreadPages {
  return {
    ...pages,
    pages: pages.pages.map((page) => ({
      ...page,
      threads: change(page.threads),
    })),
  };
}

export function patchFlagsInPages(
  pages: ThreadPages,
  threadId: ThreadId,
  flags: MessageFlags,
): ThreadPages {
  return mapPages(pages, (threads) =>
    threads.map((thread) => {
      if (thread.id !== threadId) return thread;
      return {
        ...thread,
        ...(flags.starred === undefined ? {} : { starred: flags.starred }),
        ...(flags.read === undefined
          ? {}
          : { unreadCount: flags.read ? 0 : thread.messageCount }),
      };
    }),
  );
}

const withLabel = (ids: LabelId[], labelId: LabelId, applied: boolean) => {
  const others = ids.filter((id) => id !== labelId);
  return applied ? [...others, labelId] : others;
};

export function patchLabelInPages(
  pages: ThreadPages,
  threadId: ThreadId,
  labelId: LabelId,
  applied: boolean,
): ThreadPages {
  return mapPages(pages, (threads) =>
    threads.map((thread) =>
      thread.id === threadId
        ? { ...thread, labelIds: withLabel(thread.labelIds, labelId, applied) }
        : thread,
    ),
  );
}

export function patchLabelInDetail(
  detail: ThreadDetail,
  labelId: LabelId,
  applied: boolean,
): ThreadDetail {
  return {
    ...detail,
    messages: detail.messages.map((message) => ({
      ...message,
      labelIds: withLabel(message.labelIds, labelId, applied),
    })),
  };
}

export function removeFromPages(
  pages: ThreadPages,
  threadId: ThreadId,
): ThreadPages {
  return mapPages(pages, (threads) =>
    threads.filter((thread) => thread.id !== threadId),
  );
}

export function patchFlagsInDetail(
  detail: ThreadDetail,
  flags: MessageFlags,
): ThreadDetail {
  return {
    ...detail,
    messages: detail.messages.map((message) => ({
      ...message,
      ...(flags.read === undefined ? {} : { read: flags.read }),
      ...(flags.starred === undefined ? {} : { starred: flags.starred }),
    })),
  };
}

function adjustSummary(
  entries: MailboxEntry[],
  mailboxId: MailboxId,
  view: ThreadView,
  delta: number,
): MailboxEntry[] {
  return entries.map((entry) => {
    if (entry.id !== mailboxId) return entry;
    const { summary } = entry;
    return {
      ...entry,
      summary:
        "folder" in view
          ? {
              ...summary,
              folderUnread: {
                ...summary.folderUnread,
                [view.folder]: Math.max(
                  0,
                  summary.folderUnread[view.folder] + delta,
                ),
              },
            }
          : {
              ...summary,
              labels: summary.labels.map((label) =>
                label.id === view.labelId
                  ? { ...label, unread: Math.max(0, label.unread + delta) }
                  : label,
              ),
            },
    };
  });
}

// Counts conversations, so the count changes only when a whole row goes unread
// or read, or leaves the folder.
export function summaryAfterFlags(
  entries: MailboxEntry[],
  mailboxId: MailboxId,
  view: ThreadView,
  wasUnread: boolean,
  read: boolean,
): MailboxEntry[] {
  if (wasUnread === !read) return entries;
  return adjustSummary(entries, mailboxId, view, read ? -1 : 1);
}

export function summaryAfterMove(
  entries: MailboxEntry[],
  mailboxId: MailboxId,
  from: Folder,
  move: MoveId,
  wasUnread: boolean,
): MailboxEntry[] {
  if (!wasUnread) return entries;
  const left = adjustSummary(entries, mailboxId, { folder: from }, -1);
  const to = MOVE_DISPLAY[move].to;
  return to ? adjustSummary(left, mailboxId, { folder: to }, 1) : left;
}
