import { Button, useToast } from "@cloudysuite/ui";
import { IconAlertCircle } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { dismissMoveNotice } from "../functions";
import { call, moveNoticesQuery, tasksKeys } from "../queries";
import type { BoardOfTask, MoveDestination, MoveNotice } from "../types";

const placeOf = (to: MoveDestination) =>
  to.kind === "personal" ? "your private tasks" : to.name;

const stillOnText = (board: BoardOfTask) =>
  board.kind === "personal"
    ? "It's still in your private tasks."
    : `It's still on ${board.name}.`;

// Why, then what to do next.
function reasonOf(notice: MoveNotice): { why: string; next: string | null } {
  const place = placeOf(notice.to);
  switch (notice.setback) {
    case "noAccess":
      return notice.to.kind === "team"
        ? {
            why: "because you no longer have Can edit there.",
            next: `Ask one of ${place}'s managers for Can edit, then move it again.`,
          }
        : { why: "because you can no longer add tasks there.", next: null };
    case "busy":
    case "dropped":
      return {
        why: `because ${place} couldn't take it just then.`,
        next: "Move it again in a minute.",
      };
    case "noAnswer":
      return {
        why: "because we couldn't get it there for an hour, so we stopped trying.",
        next: "Move it again to try once more.",
      };
  }
}

function Words({ notice }: { notice: MoveNotice }) {
  if (notice.task === null) {
    return (
      <strong className="font-semibold">
        A task you moved didn't move, and you can no longer open the board it's
        on.
      </strong>
    );
  }
  const { why, next } = reasonOf(notice);
  return (
    <>
      <strong className="font-semibold">
        "{notice.task.title}" didn't move to {placeOf(notice.to)}
      </strong>
      , {why} {stillOnText(notice.task.stillOn)}
      {next && <span className="text-secondary"> {next}</span>}
    </>
  );
}

function Note({ notice }: { notice: MoveNotice }) {
  const client = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function dismiss() {
    setPending(true);
    try {
      await call(() =>
        dismissMoveNotice({
          data: { boardId: notice.boardId, moveId: notice.moveId },
        }),
      );
      // Without this a failed refetch resolves too, and leaves the note up and spinning.
      await client.invalidateQueries(
        { queryKey: tasksKeys.moveNotices },
        { throwOnError: true },
      );
    } catch (failure) {
      toast({ tone: "danger", message: (failure as Error).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-start gap-2.5 rounded border border-line bg-sidebar px-3 py-2.5 text-sm">
      <span className="mt-px flex-none text-danger">
        <IconAlertCircle size={18} stroke={1.75} aria-hidden />
      </span>
      <p className="min-w-0 flex-1 break-words" dir="auto">
        <Words notice={notice} />
      </p>
      <Button
        variant="quiet"
        aria-label={
          notice.task === null
            ? "OK, hide this note"
            : `OK, hide the note about "${notice.task.title}"`
        }
        pending={pending}
        onClick={() => void dismiss()}
      >
        OK
      </Button>
    </div>
  );
}

// Under every page's heading, until the person chooses OK.
export function MoveNotices() {
  const { data: notices = [] } = useQuery(moveNoticesQuery());
  return (
    <div role="status" className="flex flex-col gap-2 px-4 pb-2.5 empty:hidden">
      {notices.map((notice) => (
        <Note key={notice.moveId} notice={notice} />
      ))}
    </div>
  );
}
