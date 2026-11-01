import type { DriveId } from "@cloudysuite/access";
import { Button, useToast } from "@cloudysuite/ui";
import { IconFolderSymlink, IconPencil, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { moveItem, renameItem, restoreItem, trashItem } from "../functions";
import { call, storageKeys } from "../queries";
import type { DriveItem, ItemId } from "../types";
import { MoveDialog } from "./move-dialog";
import { NameDialog } from "./page-parts";

export function useRestore() {
  const client = useQueryClient();
  const toast = useToast();
  return async (driveId: DriveId, itemId: ItemId, name: string) => {
    try {
      const result = await call(() =>
        restoreItem({ data: { driveId, itemId } }),
      );
      await client.invalidateQueries({ queryKey: storageKeys.all });
      const renamed =
        result.item.name === name
          ? ""
          : ` It's now called "${result.item.name}", because that name was taken.`;
      toast({
        message: result.folderGone
          ? `"${name}" is back at the top level, because the folder it was in is gone.${renamed}`
          : `"${name}" is back where it was.${renamed}`,
      });
    } catch (failure) {
      toast({ tone: "danger", message: (failure as Error).message });
    }
  };
}

export function ItemActions({
  driveId,
  item,
}: {
  driveId: DriveId;
  item: DriveItem;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const restore = useRestore();
  const [dialog, setDialog] = useState<"rename" | "move" | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: storageKeys.all });
  const stopChoosingFile = () =>
    navigate({
      to: ".",
      search: { file: undefined },
      replace: true,
      resetScroll: false,
    });
  const openFolder = (target: DriveId, folderId: ItemId | null) =>
    folderId === null
      ? navigate({ to: "/storage/drive/$driveId", params: { driveId: target } })
      : navigate({
          to: "/storage/drive/$driveId/$folderId",
          params: { driveId: target, folderId },
        });

  async function moveToTrash() {
    try {
      await call(() => trashItem({ data: { driveId, itemId: item.id } }));
      // Off the page first, or the folder being looked at reports itself missing.
      await (item.kind === "folder"
        ? openFolder(driveId, item.parentId)
        : stopChoosingFile());
      await refresh();
      toast({
        message: `"${item.name}" moved to Trash.`,
        action: {
          label: "Undo",
          run: () => void restore(driveId, item.id, item.name),
        },
      });
    } catch (failure) {
      toast({ tone: "danger", message: (failure as Error).message });
    }
  }

  return (
    <>
      <Button
        variant="toolbar"
        icon={IconPencil}
        onClick={() => setDialog("rename")}
      >
        Rename
      </Button>
      <Button
        variant="toolbar"
        icon={IconFolderSymlink}
        onClick={() => setDialog("move")}
      >
        Move
      </Button>
      <Button
        variant="toolbar"
        icon={IconTrash}
        onClick={() => void moveToTrash()}
      >
        Delete
      </Button>
      {dialog === "rename" && (
        <NameDialog
          title={`Rename "${item.name}"`}
          hint="Choose a name that isn't already used in this folder."
          submitLabel="Rename"
          initialName={item.name}
          onSubmit={async (name) => {
            await call(() =>
              renameItem({ data: { driveId, itemId: item.id, name } }),
            );
            await refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "move" && (
        <MoveDialog
          driveId={driveId}
          item={item}
          onMove={async (toDriveId, toParentId, placeName) => {
            const outcome = await call(() =>
              moveItem({
                data: { driveId, itemId: item.id, toDriveId, toParentId },
              }),
            );
            if (item.kind === "file") await stopChoosingFile();
            else if (toDriveId !== driveId) {
              await (outcome === "moved"
                ? openFolder(toDriveId, item.id)
                : openFolder(driveId, item.parentId));
            }
            await refresh();
            toast({
              message:
                outcome === "moved"
                  ? `"${item.name}" moved to ${placeName}.`
                  : `"${item.name}" is on its way to ${placeName}. This can take a minute, and you don't need to wait.`,
            });
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
