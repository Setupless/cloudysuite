import type { DriveId } from "@cloudysuite/access";
import { Avatar, useHydrated } from "@cloudysuite/ui";
import { IconFolder } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { People } from "../functions";
import type { DriveItem, FileItem, FolderItem, ItemId } from "../types";
import { focusDetailsOnNextFile } from "./details-focus";
import { FileIcon } from "./file-visuals";
import { formatBytes, formatChanged, itemCount } from "./format";
import { personOf } from "./people";

const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_60px] items-center gap-2.5 sm:grid-cols-[minmax(0,1fr)_34px_84px_60px]";
const OPTIONAL_COLUMN = "max-sm:hidden";
const ROW = `${COLUMNS} mx-2 w-[calc(100%-1rem)] cursor-pointer rounded px-2.5 py-[7px] text-left text-sm outline-accent hover:bg-field focus-visible:outline-2`;

function Cells({
  icon,
  name,
  person,
  changed,
  size,
}: {
  icon: ReactNode;
  name: string;
  person: ReactNode;
  changed: string;
  size: string;
}) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-[9px]">
        {icon}
        <span className="truncate">{name}</span>
      </span>
      <span className={`flex ${OPTIONAL_COLUMN}`}>{person}</span>
      <span
        className={`truncate text-[13px] text-secondary ${OPTIONAL_COLUMN}`}
      >
        {changed}
      </span>
      <span className="truncate text-[13px] text-secondary">{size}</span>
    </>
  );
}

function PersonCell({ people, item }: { people: People; item: DriveItem }) {
  const person = personOf(people, item.createdBy);
  return (
    <span title={person.name}>
      <Avatar person={person} size="small" />
    </span>
  );
}

function FolderRow({
  driveId,
  folder,
  people,
  changed,
}: {
  driveId: DriveId;
  folder: FolderItem;
  people: People;
  changed: string;
}) {
  return (
    <Link
      to="/storage/drive/$driveId/$folderId"
      params={{ driveId, folderId: folder.id }}
      className={ROW}
    >
      <Cells
        icon={
          <span className="flex-none text-accent">
            <IconFolder size={18} stroke={1.75} aria-hidden />
          </span>
        }
        name={folder.name}
        person={<PersonCell people={people} item={folder} />}
        changed={changed}
        size={itemCount(folder.contains)}
      />
    </Link>
  );
}

function FileRow({
  file,
  people,
  selected,
  changed,
  onSelect,
}: {
  file: FileItem;
  people: People;
  selected: boolean;
  changed: string;
  onSelect: (id: ItemId) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`${ROW} ${selected ? "bg-selected hover:bg-selected" : ""}`}
      onClick={(event) => {
        // Enter and Space report no clicks.
        if (event.detail === 0 && !selected) focusDetailsOnNextFile();
        onSelect(file.id);
      }}
    >
      <Cells
        icon={
          <span className="flex-none text-secondary">
            <FileIcon file={file} />
          </span>
        }
        name={file.name}
        person={<PersonCell people={people} item={file} />}
        changed={changed}
        size={formatBytes(file.size)}
      />
    </button>
  );
}

export type TableRow = { driveId: DriveId; item: DriveItem };

export function FileTable({
  rows,
  people,
  selectedId,
  onSelect,
}: {
  rows: readonly TableRow[];
  people: People;
  selectedId: ItemId | null;
  onSelect: (id: ItemId) => void;
}) {
  // The server knows neither the reader's time zone nor their language.
  const hydrated = useHydrated();
  const now = new Date();
  const changed = (item: DriveItem) =>
    hydrated ? formatChanged(item.changedAt, now) : " ";
  return (
    <div>
      <div
        className={`${COLUMNS} mx-4 border-b border-line px-0.5 py-[7px] text-xs font-semibold text-secondary`}
      >
        <span>Name</span>
        <span className={OPTIONAL_COLUMN} />
        <span className={OPTIONAL_COLUMN}>Changed</span>
        <span>Size</span>
      </div>
      <div className="flex flex-col">
        {rows.map(({ driveId, item }) =>
          item.kind === "folder" ? (
            <FolderRow
              key={item.id}
              driveId={driveId}
              folder={item}
              people={people}
              changed={changed(item)}
            />
          ) : (
            <FileRow
              key={item.id}
              file={item}
              people={people}
              selected={item.id === selectedId}
              changed={changed(item)}
              onSelect={onSelect}
            />
          ),
        )}
      </div>
    </div>
  );
}
