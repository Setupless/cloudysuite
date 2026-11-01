import type { DriveId } from "@cloudysuite/access";
import { Button, Modal, Notice, SelectField } from "@cloudysuite/ui";
import { IconArrowLeft, IconFolder } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ensureMyFiles } from "../functions";
import { call, directoryQuery, folderQuery } from "../queries";
import type { DriveItem, FolderItem, ItemId } from "../types";

const MY_FILES_NOT_MADE = "my-files";

function Folders({
  driveId,
  folderId,
  movingId,
  onOpen,
}: {
  driveId: DriveId;
  folderId: ItemId | null;
  movingId: ItemId;
  onOpen: (folder: FolderItem | null, id: ItemId | null) => void;
}) {
  const query = useInfiniteQuery(folderQuery(driveId, folderId));
  if (query.isError)
    return <Notice tone="danger">{query.error.message}</Notice>;
  const first = query.data?.pages[0];
  if (!first) return <p className="py-2 text-sm text-secondary">Loading…</p>;
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const folders = items.filter(
    (item): item is FolderItem =>
      item.kind === "folder" && item.id !== movingId,
  );
  const mayHaveMore = query.hasNextPage && items.at(-1)?.kind === "folder";
  return (
    <div className="flex max-h-60 flex-col overflow-y-auto">
      {first.folder && (
        <button
          type="button"
          className={FOLDER_ROW}
          onClick={() => onOpen(null, first.folder?.parentId ?? null)}
        >
          <IconArrowLeft size={18} stroke={1.75} aria-hidden />
          Back
        </button>
      )}
      {folders.map((folder) => (
        <button
          key={folder.id}
          type="button"
          className={FOLDER_ROW}
          onClick={() => onOpen(folder, folder.id)}
        >
          <span className="flex-none text-accent">
            <IconFolder size={18} stroke={1.75} aria-hidden />
          </span>
          <span className="truncate">{folder.name}</span>
        </button>
      ))}
      {folders.length === 0 && !first.folder && (
        <p className="py-2 text-sm text-secondary">No folders here yet.</p>
      )}
      {mayHaveMore && (
        <Button variant="quiet" onClick={() => void query.fetchNextPage()}>
          Show more
        </Button>
      )}
    </div>
  );
}

const FOLDER_ROW =
  "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-accent hover:bg-field focus-visible:outline-2";

export function MoveDialog({
  driveId,
  item,
  onMove,
  onClose,
}: {
  driveId: DriveId;
  item: DriveItem;
  onMove: (
    toDriveId: DriveId,
    toParentId: ItemId | null,
    placeName: string,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const { data: directory } = useQuery(directoryQuery());
  const [drive, setDrive] = useState<string>(driveId);
  const [folderId, setFolderId] = useState<ItemId | null>(item.parentId);
  const [openName, setOpenName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const myDrive = directory?.myDriveId ?? MY_FILES_NOT_MADE;
  const driveName =
    drive === myDrive
      ? "My files"
      : (directory?.teamFolders.find((team) => team.id === drive)?.name ??
        "this folder");
  const placeName = folderId === null ? driveName : (openName ?? "this folder");
  const unchanged = drive === driveId && folderId === item.parentId;

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const target =
        drive === MY_FILES_NOT_MADE
          ? await call(() => ensureMyFiles())
          : (drive as DriveId);
      await onMove(target, folderId, placeName);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setPending(false);
    }
  }

  return (
    <Modal title={`Move "${item.name}"`} onClose={onClose}>
      <SelectField
        label="Move to"
        value={drive}
        onChange={(event) => {
          setDrive(event.target.value);
          setFolderId(null);
          setOpenName(null);
        }}
      >
        <option value={myDrive}>My files</option>
        {directory?.teamFolders.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </SelectField>
      {drive === MY_FILES_NOT_MADE ? (
        <p className="py-2 text-sm text-secondary">No folders here yet.</p>
      ) : (
        <Folders
          key={drive}
          driveId={drive as DriveId}
          folderId={folderId}
          movingId={item.id}
          onOpen={(folder, id) => {
            setFolderId(id);
            setOpenName(folder?.name ?? null);
          }}
        />
      )}
      <p className="text-sm text-secondary">
        {unchanged ? "It's already here." : `It goes in ${placeName}.`}
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="toolbar" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="toolbarAction"
          disabled={pending || unchanged}
          onClick={() => void submit()}
        >
          Move here
        </Button>
      </div>
    </Modal>
  );
}
