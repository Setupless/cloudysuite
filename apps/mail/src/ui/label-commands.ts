import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createLabel, type MailboxEntry, setLabel } from "../functions";
import type { MailListing } from "../model";
import { asMailFailure, call, mailKeys } from "../queries";
import {
  patchLabelInDetail,
  patchLabelInPages,
  removeFromPages,
  type ThreadPages,
} from "../thread-cache";
import type {
  LabelColour,
  LabelId,
  MailboxId,
  ThreadDetail,
  ThreadId,
} from "../types";
import { useToast } from "./toast";

// Null means it failed, and the person has been told.
export function useCreateLabel(mailboxId: MailboxId) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return async (name: string, colour: LabelColour = "secondary") => {
    try {
      const label = await call(() =>
        createLabel({ data: { mailboxId, name, colour } }),
      );
      queryClient.setQueryData<MailboxEntry[]>(mailKeys.mailboxes, (entries) =>
        entries?.map((entry) =>
          entry.id === mailboxId
            ? {
                ...entry,
                summary: {
                  ...entry.summary,
                  labels: [
                    ...entry.summary.labels,
                    { ...label, unread: 0 },
                  ].sort((a, b) => a.name.localeCompare(b.name)),
                },
              }
            : entry,
        ),
      );
      return label;
    } catch (thrown) {
      const failure = await asMailFailure(thrown);
      toast({ tone: "danger", message: failure.message });
      return null;
    }
  };
}

type Toggle = { threadId: ThreadId; labelId: LabelId; applied: boolean };

export function useLabelCommands(mailboxId: MailboxId, listing: MailListing) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutationKey = mailKeys.all(mailboxId);
  const listKey = mailKeys.threadsIn(mailboxId, listing);

  const refresh = () => {
    if (queryClient.isMutating({ mutationKey }) > 1) return;
    void queryClient.invalidateQueries({ queryKey: mailKeys.all(mailboxId) });
    void queryClient.invalidateQueries({ queryKey: mailKeys.mailboxes });
  };

  const toggle = useMutation({
    mutationKey,
    mutationFn: ({ threadId, labelId, applied }: Toggle) =>
      call(() =>
        setLabel({
          data: {
            mailboxId,
            selection: { threadIds: [threadId] },
            labelId,
            applied,
          },
        }),
      ),
    onMutate: async ({ threadId, labelId, applied }) => {
      const threadKey = mailKeys.thread(mailboxId, threadId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: mailKeys.threads(mailboxId) }),
        queryClient.cancelQueries({ queryKey: threadKey }),
      ]);
      const before = {
        list: queryClient.getQueryData<ThreadPages>(listKey),
        detail: queryClient.getQueryData<ThreadDetail | null>(threadKey),
      };
      const leavesThisLabel =
        !applied && "labelId" in listing && listing.labelId === labelId;
      queryClient.setQueryData<ThreadPages>(
        listKey,
        (pages) =>
          pages &&
          (leavesThisLabel
            ? removeFromPages(pages, threadId)
            : patchLabelInPages(pages, threadId, labelId, applied)),
      );
      queryClient.setQueryData<ThreadDetail | null>(
        threadKey,
        (detail) => detail && patchLabelInDetail(detail, labelId, applied),
      );
      return { before, threadKey };
    },
    onError: async (thrown, _input, context) => {
      if (context) {
        queryClient.setQueryData(listKey, context.before.list);
        queryClient.setQueryData(context.threadKey, context.before.detail);
      }
      const failure = await asMailFailure(thrown);
      toast({ tone: "danger", message: failure.message });
    },
    onSettled: refresh,
  });

  return {
    setApplied: (threadId: ThreadId, labelId: LabelId, applied: boolean) =>
      toggle.mutate({ threadId, labelId, applied }),
    create: useCreateLabel(mailboxId),
  };
}

export type LabelCommands = ReturnType<typeof useLabelCommands>;
