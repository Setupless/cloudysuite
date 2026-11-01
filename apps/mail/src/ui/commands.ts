import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteForever,
  type MailboxEntry,
  moveToFolder,
  moveToTrash,
  restoreMessages,
  setFlags,
} from "../functions";
import { MOVE_DISPLAY, type MoveId } from "../model";
import { asMailFailure, call, isRefusal, mailKeys } from "../queries";
import {
  patchFlagsInDetail,
  patchFlagsInPages,
  removeFromPages,
  summaryAfterFlags,
  summaryAfterMove,
  type ThreadPages,
  threadsIn,
} from "../thread-cache";
import type {
  Folder,
  MailboxId,
  MessageFlags,
  MessageRef,
  ThreadDetail,
  ThreadId,
  ThreadView,
} from "../types";
import { useToast } from "./toast";

type Command =
  | { kind: "flags"; threadId: ThreadId; flags: MessageFlags }
  | { kind: "move"; threadId: ThreadId; from: Folder; move: MoveId };

function performMove(
  mailboxId: MailboxId,
  threadId: ThreadId,
  from: Folder,
  move: MoveId,
): Promise<MessageRef[] | number> {
  const data = {
    mailboxId,
    selection: { threadIds: [threadId], inFolder: from },
  };
  switch (move) {
    case "archive":
      return moveToFolder({ data: { ...data, folder: "archive" } });
    case "toInbox":
      return moveToFolder({ data: { ...data, folder: "inbox" } });
    case "spam":
      return moveToFolder({ data: { ...data, folder: "spam" } });
    case "trash":
      return moveToTrash({ data });
    case "restore":
    case "notSpam":
      return restoreMessages({ data });
    case "deleteForever":
      return deleteForever({ data });
  }
}

const FAILURE_NOTE = "Nothing changed. Try again.";

export function useThreadCommands(mailboxId: MailboxId, view: ThreadView) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutationKey = mailKeys.all(mailboxId);
  const listKey = mailKeys.threadsIn(mailboxId, view);

  const refreshUnlessBusy = () => {
    if (queryClient.isMutating({ mutationKey }) > 1) return;
    void queryClient.invalidateQueries({ queryKey: mailKeys.all(mailboxId) });
    void queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
  };

  const undoMove = useMutation({
    mutationKey,
    mutationFn: async (refs: MessageRef[]) => {
      const byFolder = Map.groupBy(refs, (ref) => ref.folder);
      await call(() =>
        Promise.all(
          [...byFolder].map(([folder, group]) =>
            moveToFolder({
              data: {
                mailboxId,
                folder,
                selection: { messageIds: group.map((ref) => ref.messageId) },
              },
            }),
          ),
        ),
      );
    },
    onError: () =>
      toast({
        tone: "danger",
        message: "We couldn't undo that. The conversation is still moved.",
      }),
    onSettled: refreshUnlessBusy,
  });

  const command = useMutation({
    mutationKey,
    mutationFn: (input: Command) =>
      call(async () =>
        input.kind === "flags"
          ? setFlags({
              data: {
                mailboxId,
                flags: input.flags,
                selection: { threadIds: [input.threadId] },
              },
            })
          : performMove(mailboxId, input.threadId, input.from, input.move),
      ),

    onMutate: async (input) => {
      const threadKey = mailKeys.thread(mailboxId, input.threadId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: mailKeys.threads(mailboxId) }),
        queryClient.cancelQueries({ queryKey: threadKey }),
        queryClient.cancelQueries({ queryKey: mailKeys.mailboxes }),
      ]);
      const before = {
        list: queryClient.getQueryData<ThreadPages>(listKey),
        detail: queryClient.getQueryData<ThreadDetail | null>(threadKey),
        mailboxes: queryClient.getQueryData<MailboxEntry[]>(mailKeys.mailboxes),
      };
      const row = threadsIn(before.list).find(
        (thread) => thread.id === input.threadId,
      );
      const wasUnread =
        row !== undefined
          ? row.unreadCount > 0
          : (before.detail?.messages.some((message) => !message.read) ?? false);

      if (input.kind === "flags") {
        queryClient.setQueryData<ThreadPages>(
          listKey,
          (pages) =>
            pages && patchFlagsInPages(pages, input.threadId, input.flags),
        );
        queryClient.setQueryData<ThreadDetail | null>(
          threadKey,
          (detail) => detail && patchFlagsInDetail(detail, input.flags),
        );
        const { read } = input.flags;
        if (read !== undefined) {
          queryClient.setQueryData<MailboxEntry[]>(
            mailKeys.mailboxes,
            (entries) =>
              entries &&
              summaryAfterFlags(entries, mailboxId, view, wasUnread, read),
          );
        }
      } else {
        queryClient.setQueryData<ThreadPages>(
          listKey,
          (pages) => pages && removeFromPages(pages, input.threadId),
        );
        queryClient.setQueryData<MailboxEntry[]>(
          mailKeys.mailboxes,
          (entries) =>
            entries &&
            summaryAfterMove(
              entries,
              mailboxId,
              input.from,
              input.move,
              wasUnread,
            ),
        );
      }
      return { before, threadKey };
    },

    onError: async (thrown, input, context) => {
      if (context) {
        queryClient.setQueryData(listKey, context.before.list);
        queryClient.setQueryData(context.threadKey, context.before.detail);
        queryClient.setQueryData(mailKeys.mailboxes, context.before.mailboxes);
      }
      const failure = await asMailFailure(thrown);
      toast({
        tone: "danger",
        message: isRefusal(failure)
          ? failure.message
          : input.kind === "move"
            ? `We couldn't ${MOVE_DISPLAY[input.move].verb} that conversation. ${FAILURE_NOTE}`
            : `We couldn't update that conversation. ${FAILURE_NOTE}`,
      });
    },

    onSuccess: (result, input, context) => {
      if (input.kind !== "move") return;
      const display = MOVE_DISPLAY[input.move];
      if (!Array.isArray(result)) {
        toast({ message: display.done });
        return;
      }
      toast({
        message: display.done,
        action: {
          label: "Undo",
          run: () => {
            queryClient.setQueryData(listKey, context.before.list);
            queryClient.setQueryData(
              mailKeys.mailboxes,
              context.before.mailboxes,
            );
            undoMove.mutate(result);
          },
        },
      });
    },

    onSettled: refreshUnlessBusy,
  });

  return {
    setRead: (threadId: ThreadId, read: boolean) =>
      command.mutate({ kind: "flags", threadId, flags: { read } }),
    setStarred: (threadId: ThreadId, starred: boolean) =>
      command.mutate({ kind: "flags", threadId, flags: { starred } }),
    move: (threadId: ThreadId, from: Folder, move: MoveId) =>
      command.mutate({ kind: "move", threadId, from, move }),
  };
}

export type ThreadCommands = ReturnType<typeof useThreadCommands>;
