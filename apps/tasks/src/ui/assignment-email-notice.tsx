import type { BoardId } from "@cloudysuite/access";
import { Button, Notice } from "@cloudysuite/ui";
import { IconMailOff, IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { retryAssignmentEmail } from "../functions";
import { assignmentEmailQuery, call, tasksKeys } from "../queries";
import type { NotEmailedReason, Person, TaskId } from "../types";

// What happened, and what to do next.
const NOT_EMAILED_TEXT: Record<NotEmailedReason, (name: string) => string> = {
  tasksOff: () =>
    "Tasks was off when the email was due, so it didn't go. Try again now it's back on.",
  mailOff: () =>
    "Mail was off, so the email didn't go. Try again once Mail is back on.",
  assigneeCantOpen: (name) =>
    `${name} can no longer open this board, so the email didn't go. Add them back, then try again.`,
  assignerCantEdit: (name) =>
    `Whoever assigned the task can no longer edit this board, so the email didn't go. Ask a manager to give them Can edit again, then try again, or tell ${name} yourself.`,
  noSender: (name) =>
    `Emails go from the address of whoever assigned the task, which can't send now. Their mailbox may be gone, or their account suspended. Ask your admin, then try again, or tell ${name} yourself.`,
  noAddress: (name) =>
    `${name} has no email address, so the email didn't go. Ask your admin to give them a mailbox, then try again.`,
  checkUnavailable: () =>
    "We couldn't confirm the email was still allowed to go, so it didn't. Try again in a few minutes.",
  rateLimited: () =>
    "Too much mail was going out, so the email didn't go. Try again in a few minutes.",
  senderNotVerified: () =>
    "The sending address isn't set up to send mail yet. Ask your admin to finish setting up the domain, then try again.",
  dailyLimit: () =>
    "Your organisation reached today's sending limit. Try again tomorrow.",
  accountSuspended: () =>
    "Cloudflare has paused sending for your organisation. Ask your admin to check the Cloudflare account.",
  recipientNotAllowed: (name) =>
    `Your organisation's settings don't allow mail to ${name}'s address. Ask your admin.`,
  recipientSuppressed: (name) =>
    `${name}'s address can't get mail from your organisation, because an earlier message bounced or was reported. Check the address with them.`,
  deliveryRefused: (name) =>
    `${name}'s mail server refused the email. Try again later.`,
  invalidMessage: () =>
    "Something in this email couldn't be sent. Try again, and tell your admin if it happens again.",
};

// Shown to people who can edit the board, under who the task is assigned to. Nothing
// shows while the email waits or once it has gone.
export function AssignmentEmailNotice({
  boardId,
  taskId,
  assignee,
}: {
  boardId: BoardId;
  taskId: TaskId;
  assignee: Person;
}) {
  const client = useQueryClient();
  const { data } = useQuery(assignmentEmailQuery(boardId, taskId, assignee.id));
  const [trying, setTrying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (data?.state !== "notSent" && data?.state !== "unclear") return null;

  async function tryAgain() {
    setTrying(true);
    setFailure(null);
    try {
      await call(() => retryAssignmentEmail({ data: { boardId, taskId } }));
      await client.invalidateQueries({
        queryKey: tasksKeys.assignmentEmail(boardId, taskId, assignee.id),
      });
    } catch (thrown) {
      setFailure((thrown as Error).message);
    } finally {
      setTrying(false);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded border border-line px-2.5 py-2 text-[13px]"
    >
      <span className="flex items-center gap-2 font-semibold text-danger">
        <IconMailOff
          size={16}
          stroke={1.75}
          aria-hidden
          className="flex-none"
        />
        <span dir="auto" className="min-w-0">
          {data.state === "unclear"
            ? `${assignee.name} may not have been emailed`
            : `${assignee.name} wasn't emailed`}
        </span>
      </span>
      <span className="text-secondary">
        {data.state === "unclear"
          ? `We can't tell whether the email reached ${assignee.name}. Check with them before you try again.`
          : NOT_EMAILED_TEXT[data.reason](assignee.name)}
      </span>
      <span>
        <Button
          variant="toolbar"
          icon={IconRefresh}
          pending={trying}
          onClick={() => void tryAgain()}
        >
          Try again
        </Button>
      </span>
      {failure && <Notice tone="danger">{failure}</Notice>}
    </div>
  );
}
