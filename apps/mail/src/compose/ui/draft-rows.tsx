import { Badge } from "@cloudysuite/ui";
import { IconPaperclip } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { callAction, isRefusal } from "../../queries";
import { NotSavedOnDevice } from "../../failure";
import { FOLDER_DISPLAY } from "../../model";
import { recipientLabel } from "../../ui/format";
import { FailureNotice, SkeletonLines, ThreadDate } from "../../ui/states";
import { useToast } from "../../ui/toast";
import { reopenOutgoing } from "../functions";
import {
  type OutgoingSummary,
  SEND_FAILURES,
  UNKNOWN_OUTCOME_TEXT,
} from "../types";
import { useCompose } from "./compose-context";
import { composeKeys, isOnItsWay, outgoingQuery } from "./queries";

function statusOf(job: OutgoingSummary): {
  badge: string;
  tone: "neutral" | "danger";
  detail?: string;
} | null {
  switch (job.state) {
    case "scheduled":
    case "sending":
    case "accepted":
      return { badge: "Sending", tone: "neutral" };
    case "failed":
      return {
        badge: "Not sent",
        tone: "danger",
        detail: job.failure ? SEND_FAILURES[job.failure] : undefined,
      };
    case "unknown":
      return {
        badge: "Check this",
        tone: "danger",
        detail: UNKNOWN_OUTCOME_TEXT,
      };
    default:
      return null;
  }
}

// Drafts aren't conversations, so this folder reads the send job table, not the
// message list. A message that failed stays here, so it can't quietly disappear.
export function DraftRows() {
  const { mailboxId, session, openDraft } = useCompose();
  const queryClient = useQueryClient();
  const toast = useToast();
  const outgoing = useQuery(outgoingQuery(mailboxId));

  if (outgoing.isPending) return <SkeletonLines rows={6} />;
  if (outgoing.isError) {
    return (
      <FailureNotice
        message={outgoing.error.message}
        onRetry={
          isRefusal(outgoing.error) ||
          outgoing.error instanceof NotSavedOnDevice
            ? undefined
            : () => void outgoing.refetch()
        }
      />
    );
  }

  const rows = outgoing.data.filter((job) => job.state !== "sent");
  if (rows.length === 0) {
    return (
      <p className="px-6 py-12 text-center text-sm text-secondary">
        {FOLDER_DISPLAY.drafts.empty}
      </p>
    );
  }

  const open = async (job: OutgoingSummary) => {
    if (isOnItsWay(job)) return;
    if (job.state !== "draft") {
      try {
        await callAction(() =>
          reopenOutgoing({ data: { mailboxId, id: job.id } }),
        );
      } catch (error) {
        toast({ tone: "danger", message: (error as Error).message });
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: composeKeys.outgoing(mailboxId),
      });
    }
    openDraft(
      job.id,
      job.state === "unknown" ? { warning: UNKNOWN_OUTCOME_TEXT } : undefined,
    );
  };

  return (
    <ul className="flex flex-col gap-px">
      {rows.map((job) => {
        const status = statusOf(job);
        const people = job.to.map(recipientLabel).join(", ");
        return (
          <li
            key={job.id}
            className={`mx-2 rounded ${session?.id === job.id ? "bg-selected" : "hover:bg-field"}`}
          >
            <button
              type="button"
              disabled={isOnItsWay(job)}
              onClick={() => void open(job)}
              className="flex w-full cursor-pointer flex-col gap-0.5 rounded px-2.5 py-2.5 text-left outline-accent focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:cursor-default"
            >
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {people || "(No recipient yet)"}
                </span>
                <ThreadDate timestamp={job.updatedAt} />
              </span>
              <span className="truncate text-sm">
                {job.subject.trim() || "(No subject)"}
              </span>
              <span className="flex items-center gap-1.5 text-[13px] text-secondary">
                <span className="min-w-0 flex-1 truncate">
                  {status?.detail ?? job.snippet}
                </span>
                {job.attachmentCount > 0 && (
                  <IconPaperclip
                    size={14}
                    stroke={1.75}
                    className="flex-none"
                    aria-label="Has attachments"
                  />
                )}
                {status && <Badge tone={status.tone}>{status.badge}</Badge>}
              </span>
              <span className="text-xs text-secondary">
                Last changed by {job.updatedByName}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
