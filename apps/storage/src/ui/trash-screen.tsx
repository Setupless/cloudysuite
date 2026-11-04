import { Button, useHydrated } from "@cloudysuite/ui";
import {
  IconFolder,
  IconRestore,
  IconTrash,
  IconTrashX,
} from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { deleteItemForever, emptyTrash, type TrashLine } from "../functions";
import { call, refreshStorage, trashQuery } from "../queries";
import { TRASH_DAYS } from "../types";
import { NothingChosenPanel, PANEL } from "./details-panel";
import {
  detailsPanelId,
  focusDetailsIfAsked,
  focusDetailsOnNextFile,
} from "./details-focus";
import { FileIcon } from "./file-visuals";
import { formatBytes, formatChanged, itemCount } from "./format";
import { useRestore } from "./item-actions";
import {
  Breadcrumb,
  ConfirmDialog,
  LoadingPage,
  PageTop,
  Problem,
} from "./page-parts";

const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_60px] items-center gap-2.5 sm:grid-cols-[minmax(0,1fr)_110px_84px_60px]";
const OPTIONAL_COLUMN = "max-sm:hidden";

const keyOf = (line: TrashLine) => `${line.drive.id}/${line.entry.id}`;

function Icon({ line }: { line: TrashLine }) {
  const { entry } = line;
  if (entry.kind === "folder") {
    return (
      <span className="flex-none text-accent">
        <IconFolder size={18} stroke={1.75} aria-hidden />
      </span>
    );
  }
  return (
    <span className="flex-none text-secondary">
      <FileIcon
        file={{
          name: entry.name,
          mimeType: entry.mimeType ?? "application/octet-stream",
        }}
      />
    </span>
  );
}

function Panel({ line, onGone }: { line: TrashLine; onGone: () => void }) {
  const client = useQueryClient();
  const restore = useRestore();
  const hydrated = useHydrated();
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const { entry, drive } = line;
  const when = (timestamp: number) =>
    hydrated ? formatChanged(timestamp, new Date()) : " ";
  const facts: [string, string][] = [
    ["Size", formatBytes(entry.size)],
    ...(entry.kind === "folder"
      ? ([["Contains", itemCount(entry.contains)]] as [string, string][])
      : []),
    ["Was in", entry.fromFolder?.name ?? drive.name],
    ["Deleted", when(entry.trashedAt)],
    ["Goes for good", when(entry.purgeAt)],
  ];
  useEffect(focusDetailsIfAsked, []);
  const folderGone =
    entry.fromFolder !== null && entry.fromFolder.name === null;
  return (
    <aside
      id={detailsPanelId}
      tabIndex={-1}
      aria-label="Details"
      className={PANEL}
    >
      <div className="sticky top-3.5 flex flex-col gap-3">
        <h2 className="text-[15px] font-semibold break-words">{entry.name}</h2>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="toolbar"
            icon={IconRestore}
            pending={restoring}
            onClick={async () => {
              setRestoring(true);
              if (await restore(drive.id, entry.id, entry.name)) onGone();
              else setRestoring(false);
            }}
          >
            Restore
          </Button>
          <Button
            variant="toolbar"
            icon={IconTrashX}
            disabled={restoring}
            onClick={() => setConfirming(true)}
          >
            Delete forever
          </Button>
        </div>
        {folderGone && (
          <p className="text-[13px] text-secondary">
            The folder this was in is gone, so it will go back to the top of{" "}
            {drive.name}.
          </p>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-secondary">{label}</dt>
              <dd className="truncate text-right" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {confirming && (
        <ConfirmDialog
          title={`Delete "${entry.name}" forever?`}
          body={
            entry.kind === "folder"
              ? "This folder and everything in it will be gone for good, for everyone. You can't undo this."
              : "This file will be gone for good, for everyone. You can't undo this."
          }
          confirmLabel="Delete forever"
          onConfirm={async () => {
            await call(() =>
              deleteItemForever({
                data: { driveId: drive.id, itemId: entry.id },
              }),
            );
            await refreshStorage(client);
            onGone();
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </aside>
  );
}

function Trash() {
  const client = useQueryClient();
  const query = useQuery(trashQuery());
  const hydrated = useHydrated();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  if (query.isError) return <Problem message={query.error.message} />;
  if (!query.data) return <LoadingPage title="Trash" />;
  const { lines, more } = query.data;
  const chosen = lines.find((line) => keyOf(line) === selected);
  const now = new Date();

  return (
    <div className="flex min-h-[calc(100dvh-52px)] max-[899px]:flex-col">
      <div className="min-w-0 flex-1 pb-4">
        <Breadcrumb trail={[]} current="Trash" />
        <PageTop title="Trash">
          {lines.length > 0 && (
            <Button
              variant="toolbar"
              icon={IconTrashX}
              onClick={() => setConfirmingEmpty(true)}
            >
              Empty Trash
            </Button>
          )}
        </PageTop>
        {lines.length === 0 ? (
          <div className="mx-auto my-[60px] flex max-w-[280px] flex-col items-center gap-2 text-center text-sm text-secondary">
            <IconTrash size={34} stroke={1.75} aria-hidden />
            <strong className="font-semibold text-text">
              Nothing in Trash
            </strong>
          </div>
        ) : (
          <>
            <p className="px-4 pb-2 text-[13px] text-secondary">
              Things here are deleted for good after {TRASH_DAYS} days. Until
              then they still count towards your organisation's storage.
            </p>
            <div
              className={`${COLUMNS} mx-4 border-b border-line px-0.5 py-[7px] text-xs font-semibold text-secondary`}
            >
              <span>Name</span>
              <span className={OPTIONAL_COLUMN}>From</span>
              <span className={OPTIONAL_COLUMN}>Deleted</span>
              <span>Size</span>
            </div>
            <div className="flex flex-col">
              {lines.map((line) => (
                <button
                  key={keyOf(line)}
                  type="button"
                  aria-pressed={keyOf(line) === selected}
                  className={`${COLUMNS} mx-2 w-[calc(100%-1rem)] cursor-pointer rounded px-2.5 py-[7px] text-left text-sm outline-accent hover:bg-field focus-visible:outline-2 ${keyOf(line) === selected ? "bg-selected hover:bg-selected" : ""}`}
                  onClick={(event) => {
                    const choosing = keyOf(line) !== selected;
                    if (event.detail === 0 && choosing)
                      focusDetailsOnNextFile();
                    setSelected(choosing ? keyOf(line) : null);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-[9px]">
                    <Icon line={line} />
                    <span className="truncate">{line.entry.name}</span>
                  </span>
                  <span
                    className={`truncate text-[13px] text-secondary ${OPTIONAL_COLUMN}`}
                  >
                    {line.drive.name}
                  </span>
                  <span
                    className={`truncate text-[13px] text-secondary ${OPTIONAL_COLUMN}`}
                  >
                    {hydrated ? formatChanged(line.entry.trashedAt, now) : " "}
                  </span>
                  <span className="truncate text-[13px] text-secondary">
                    {formatBytes(line.entry.size)}
                  </span>
                </button>
              ))}
            </div>
            {more && (
              <p className="px-4 pt-3 text-[13px] text-secondary">
                Showing the {lines.length} most recently deleted. Delete or
                restore some to see the rest.
              </p>
            )}
          </>
        )}
      </div>
      {chosen ? (
        <Panel
          key={keyOf(chosen)}
          line={chosen}
          onGone={() => setSelected(null)}
        />
      ) : (
        <NothingChosenPanel message="Choose something to see its details." />
      )}
      {confirmingEmpty && (
        <ConfirmDialog
          title="Empty Trash?"
          body="Everything in Trash will be gone for good, including things other people deleted from team folders you're on. You can't undo this."
          confirmLabel="Empty Trash"
          onConfirm={async () => {
            await call(() => emptyTrash());
            setSelected(null);
            await refreshStorage(client);
          }}
          onClose={() => setConfirmingEmpty(false)}
        />
      )}
    </div>
  );
}

export function TrashScreen({
  prefetched,
}: {
  prefetched: DehydratedState | undefined;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <Trash />
    </HydrationBoundary>
  );
}
