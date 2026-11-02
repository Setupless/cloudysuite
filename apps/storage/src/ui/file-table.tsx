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
import { StarButton } from "./star-button";

const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_60px_28px] items-center gap-2.5 sm:grid-cols-[minmax(0,1fr)_34px_84px_60px_28px]";
const OPTIONAL_COLUMN = "max-sm:hidden";
// Over the row's last column: its margin and padding from the right.
const STAR_SLOT = "absolute top-1/2 right-[18px] flex -translate-y-1/2";
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
      <span />
    </>
  );
}

function PersonCell({ people, id }: { people: People; id: string }) {
  const person = personOf(people, id);
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
  personId,
  changed,
}: {
  driveId: DriveId;
  folder: FolderItem;
  people: People;
  personId: string;
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
        person={<PersonCell people={people} id={personId} />}
        changed={changed}
        size={itemCount(folder.contains)}
      />
    </Link>
  );
}

function FileRow({
  file,
  people,
  personId,
  selected,
  changed,
  onSelect,
}: {
  file: FileItem;
  people: People;
  personId: string;
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
        person={<PersonCell people={people} id={personId} />}
        changed={changed}
        size={formatBytes(file.size)}
      />
    </button>
  );
}

// Shared with me shows who shared and when, in place of who added it and when it changed.
export type TableRow = {
  driveId: DriveId;
  item: DriveItem;
  person?: string;
  at?: number;
};

export function FileTable({
  rows,
  people,
  selectedId,
  dateLabel = "Changed",
  onSelect,
}: {
  dateLabel?: string;
  rows: readonly TableRow[];
  people: People;
  selectedId: ItemId | null;
  onSelect: (id: ItemId) => void;
}) {
  // The server knows neither the reader's time zone nor their language.
  const hydrated = useHydrated();
  const now = new Date();
  const changed = (at: number) => (hydrated ? formatChanged(at, now) : " ");
  return (
    <div>
      <div
        className={`${COLUMNS} mx-4 border-b border-line px-0.5 py-[7px] text-xs font-semibold text-secondary`}
      >
        <span>Name</span>
        <span className={OPTIONAL_COLUMN} />
        <span className={OPTIONAL_COLUMN}>{dateLabel}</span>
        <span>Size</span>
        <span />
      </div>
      <div className="flex flex-col">
        {rows.map(({ driveId, item, person, at }) => (
          <div key={item.id} className="relative">
            {item.kind === "folder" ? (
              <FolderRow
                driveId={driveId}
                folder={item}
                people={people}
                personId={person ?? item.createdBy}
                changed={changed(at ?? item.changedAt)}
              />
            ) : (
              <FileRow
                file={item}
                people={people}
                personId={person ?? item.createdBy}
                selected={item.id === selectedId}
                changed={changed(at ?? item.changedAt)}
                onSelect={onSelect}
              />
            )}
            {/* Beside the row, because a button can't go inside a link or a button. */}
            <span className={STAR_SLOT}>
              <StarButton driveId={driveId} item={item} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
