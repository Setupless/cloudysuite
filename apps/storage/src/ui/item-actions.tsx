import type { DriveId } from "@cloudysuite/access";
import { Button, useToast } from "@cloudysuite/ui";
import { IconFolderSymlink, IconPencil, IconTrash } from "@tabler/icons-react";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { moveItem, renameItem, restoreItem, trashItem } from "../functions";
import { call, refreshStorage } from "../queries";
import type { DriveItem, ItemId } from "../types";
import { MoveDialog } from "./move-dialog";
import { NameDialog } from "./page-parts";

export function useRestore() {
  const client = useQueryClient();
  const toast = useToast();
  // Resolves true once it's back and the lists show it.
  return async (
    driveId: DriveId,
    itemId: ItemId,
    name: string,
  ): Promise<boolean> => {
    try {
      const result = await call(() =>
        restoreItem({ data: { driveId, itemId } }),
      );
      await refreshStorage(client);
      const renamed =
        result.item.name === name
          ? ""
          : ` It's now called "${result.item.name}", because that name was taken.`;
      toast({
        message: result.folderGone
          ? `"${name}" is back at the top level, because the folder it was in is gone.${renamed}`
          : `"${name}" is back where it was.${renamed}`,
      });
      return true;
    } catch (failure) {
      toast({ tone: "danger", message: (failure as Error).message });
      return false;
    }
  };
}

export function ItemActions({
  driveId,
  item,
  shared,
}: {
  driveId: DriveId;
  item: DriveItem;
  // Reached through a share. A shared item shows no parent, and the drive's root is out
  // of reach, so leaving it goes to Shared with me.
  shared: boolean;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const restore = useRestore();
  const [dialog, setDialog] = useState<"rename" | "move" | null>(null);
  // Kept by the query client, not this panel, so picking another file and coming back
  // still shows it running.
  const trashKey = ["trash", driveId, item.id];
  const trashing = useIsMutating({ mutationKey: trashKey }) > 0;
  const trash = useMutation({ mutationKey: trashKey, mutationFn: moveToTrash });

  const refresh = () => refreshStorage(client);
  const stopChoosingFile = () =>
    navigate({
      to: ".",
      search: { file: undefined },
      replace: true,
      resetScroll: false,
    });
  const openFolder = (target: DriveId, folderId: ItemId | null) =>
    shared && target === driveId && folderId === null
      ? navigate({ to: "/storage/shared" })
      : folderId === null
        ? navigate({
            to: "/storage/drive/$driveId",
            params: { driveId: target },
          })
        : navigate({
            to: "/storage/drive/$driveId/$folderId",
            params: { driveId: target, folderId },
          });

  // The person may have gone on to something else while it was saving.
  const stillShown = () =>
    item.kind === "folder"
      ? router.state.matches.some(
          (match) =>
            "folderId" in match.params && match.params.folderId === item.id,
        )
      : router.state.location.search.file === item.id;

  async function moveToTrash() {
    try {
      await call(() => trashItem({ data: { driveId, itemId: item.id } }));
      // A folder being looked at must be left first, or it reports itself missing.
      // A file's panel stays until the list has caught up.
      if (item.kind === "folder") {
        if (stillShown()) await openFolder(driveId, item.parentId);
        await refresh();
      } else {
        await refresh();
        if (stillShown()) await stopChoosingFile();
      }
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
      {!(shared && item.parentId === null) && (
        <Button
          variant="toolbar"
          icon={IconPencil}
          disabled={trashing}
          onClick={() => setDialog("rename")}
        >
          Rename
        </Button>
      )}
      <Button
        variant="toolbar"
        icon={IconFolderSymlink}
        disabled={trashing}
        onClick={() => setDialog("move")}
      >
        Move
      </Button>
      <Button
        variant="toolbar"
        icon={IconTrash}
        pending={trashing}
        onClick={() => trash.mutate()}
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
            if (item.kind === "file") {
              await refresh();
              await stopChoosingFile();
            } else {
              if (toDriveId !== driveId) {
                await (outcome === "moved"
                  ? openFolder(toDriveId, item.id)
                  : openFolder(driveId, item.parentId));
              }
              await refresh();
            }
            toast({
              message:
                outcome === "moved"
                  ? `"${item.name}" moved to ${placeName}.`
                  : `"${item.name}" is on its way to ${placeName}. This can take a minute, and you don't need to wait. If it can't move, you'll see why here.`,
            });
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
