import type { DriveId } from "@cloudysuite/access";
import { Button, useToast } from "@cloudysuite/ui";
import { IconAlertCircle } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { dismissMoveNotice } from "../functions";
import { call, storageKeys } from "../queries";
import type { MoveNotice, MoveSetback } from "../types";
import { formatBytes } from "./format";

function whatToDo(setback: MoveSetback): string {
  switch (setback.status) {
    case "overLimit":
      return `There wasn't room for its ${formatBytes(setback.bytes)} in My files. Delete something there or ask your admin for more space, then move it again.`;
    case "nameTaken":
      return "Something with the same name was already where it was going. Rename one of them, then move it again.";
    case "noDestination":
      return "The place it was going to no longer exists. Move it again and choose another place.";
    case "folderBusy":
      return "The folder it was going to was being moved too. Move it again in a minute.";
    case "noAnswer":
      return "We couldn't reach the place it was going to for an hour, so we stopped trying. Move it again to try once more.";
  }
}

export function MoveNotices({
  driveId,
  notices,
}: {
  driveId: DriveId;
  notices: MoveNotice[];
}) {
  const client = useQueryClient();
  const toast = useToast();

  async function dismiss(moveId: string) {
    try {
      await call(() => dismissMoveNotice({ data: { driveId, moveId } }));
      await client.invalidateQueries({ queryKey: storageKeys.all });
    } catch (failure) {
      toast({ tone: "danger", message: (failure as Error).message });
    }
  }

  return (
    <div role="status" className="flex flex-col gap-2 px-4 pb-2.5 empty:hidden">
      {notices.map((notice) => (
        <div
          key={notice.moveId}
          className="flex items-start gap-2.5 rounded border border-line bg-sidebar px-3 py-2.5 text-sm"
        >
          <span className="mt-px flex-none text-danger">
            <IconAlertCircle size={18} stroke={1.75} aria-hidden />
          </span>
          <p className="min-w-0 flex-1 break-words">
            <strong className="font-semibold">
              "{notice.name}" didn't move, and it's still where it was.
            </strong>{" "}
            <span className="text-secondary">{whatToDo(notice.setback)}</span>
          </p>
          <Button
            variant="quiet"
            aria-label={`OK, hide the note about "${notice.name}"`}
            onClick={() => void dismiss(notice.moveId)}
          >
            OK
          </Button>
        </div>
      ))}
    </div>
  );
}
