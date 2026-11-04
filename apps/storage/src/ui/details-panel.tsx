import type { DriveId, DriveRole } from "@cloudysuite/access";
import type { SignedIn } from "@cloudysuite/auth/session";
import {
  Avatar,
  Button,
  buttonClass,
  useHydrated,
  useToast,
} from "@cloudysuite/ui";
import {
  IconDownload,
  IconFolder,
  IconPencil,
  IconShare,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { accessQuery, call, refreshStorage } from "../queries";
import { deleteTeamFolder, renameTeamFolder } from "../sharing-functions";
import type { DriveItem, FileItem, FolderItem, ItemId } from "../types";
import { ACCESS_LABELS } from "./access-labels";
import { detailsPanelId, focusDetailsIfAsked } from "./details-focus";
import { FilePreview } from "./file-visuals";
import { formatBytes, formatChanged, itemCount } from "./format";
import { ItemActions } from "./item-actions";
import { BONE, ConfirmDialog, Loading, NameDialog } from "./page-parts";
import { ShareDialog } from "./share-dialog";
import { StarButton } from "./star-button";
import { TeamDialog } from "./team-dialog";

export type TeamRoot = { driveId: DriveId; name: string; role: DriveRole };

export type PanelSubject =
  | {
      kind: "folder";
      name: string;
      contains: number;
      changedAt: number | null;
      createdBy: string;
      // Null for My files before it exists.
      driveId: DriveId | null;
      // Null for a drive's root, which is not an item and has no item actions.
      folder: FolderItem | null;
      // Only at the root of a team folder.
      team: TeamRoot | null;
      canEdit: boolean;
      shared: boolean;
    }
  | {
      kind: "file";
      driveId: DriveId;
      file: FileItem;
      addedBy: string;
      canEdit: boolean;
      shared: boolean;
    };

export const PANEL =
  "flex-none border-line p-3.5 outline-none max-[899px]:border-t min-[900px]:w-[262px] min-[900px]:border-l";

function AccessRow({
  icon,
  name,
  label,
}: {
  icon: React.ReactNode;
  name: string;
  label: string;
}) {
  return (
    <li className="flex items-center gap-2 text-[13px]">
      {icon}
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
      <em className="ml-auto flex-none text-xs text-secondary not-italic">
        {label}
      </em>
    </li>
  );
}

function WhoCanOpen({
  driveId,
  itemId,
  me,
}: {
  driveId: DriveId | null;
  itemId: ItemId | null;
  me: SignedIn;
}) {
  const query = useQuery({
    ...accessQuery(driveId as DriveId, itemId),
    enabled: driveId !== null,
  });
  const { data } = query;
  const onlyMe =
    driveId === null ||
    (data?.lines.length === 1 &&
      data.lines[0]?.person.id === me.id &&
      data.lines[0].access === "owner" &&
      data.everyone === null);
  if (!onlyMe && query.isError) {
    return <p className="text-[13px] text-danger">{query.error.message}</p>;
  }
  if (!onlyMe && !data) {
    return (
      <Loading className="flex flex-col gap-2">
        {["w-24", "w-32"].map((width) => (
          <span key={width} aria-hidden className="flex items-center gap-2">
            <span className={`size-[22px] flex-none rounded-full ${BONE}`} />
            <span className={`h-3 ${width} ${BONE}`} />
          </span>
        ))}
      </Loading>
    );
  }
  if (onlyMe) {
    return (
      <ul>
        <AccessRow
          icon={<Avatar person={me} size="small" />}
          name="Only you"
          label={ACCESS_LABELS.owner}
        />
      </ul>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {data?.everyone && (
        <AccessRow
          icon={
            <span className="flex size-[22px] flex-none items-center justify-center rounded-full bg-field text-secondary">
              <IconUsers size={13} stroke={1.75} aria-hidden />
            </span>
          }
          name={`Everyone at ${data.organisation}`}
          label={ACCESS_LABELS.viewer}
        />
      )}
      {data?.lines.map(({ person, access }) => (
        <AccessRow
          key={person.id}
          icon={<Avatar person={person} size="small" />}
          name={person.id === me.id ? `${person.name} (you)` : person.name}
          label={ACCESS_LABELS[access]}
        />
      ))}
    </ul>
  );
}

function ShareButton({ driveId, item }: { driveId: DriveId; item: DriveItem }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="toolbarAction"
        icon={IconShare}
        onClick={() => setOpen(true)}
      >
        Share
      </Button>
      {open && (
        <ShareDialog
          driveId={driveId}
          item={item}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function TeamActions({ team, me }: { team: TeamRoot; me: SignedIn }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [dialog, setDialog] = useState<"people" | "rename" | "delete" | null>(
    null,
  );
  const { driveId, name } = team;
  return (
    <>
      <Button
        variant="toolbarAction"
        icon={IconUsers}
        onClick={() => setDialog("people")}
      >
        People
      </Button>
      {team.role === "manager" && (
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
            icon={IconTrash}
            onClick={() => setDialog("delete")}
          >
            Delete
          </Button>
        </>
      )}
      {dialog === "people" && (
        <TeamDialog
          driveId={driveId}
          name={name}
          meId={me.id}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "rename" && (
        <NameDialog
          title={`Rename ${name}`}
          hint="Everyone on this team folder will see the new name."
          submitLabel="Rename"
          initialName={name}
          onSubmit={async (next) => {
            await call(() =>
              renameTeamFolder({ data: { driveId, name: next } }),
            );
            await refreshStorage(client);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={`Delete ${name}?`}
          body="A team folder can only be deleted when it's empty, including its Trash. Everyone on it loses it from their list, and this can't be undone."
          confirmLabel="Delete team folder"
          onConfirm={async () => {
            await call(() => deleteTeamFolder({ data: { driveId } }));
            await navigate({ to: "/storage" });
            await refreshStorage(client);
            toast({ message: `${name} is deleted.` });
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

export function DetailsPanel({
  subject,
  me,
}: {
  subject: PanelSubject;
  me: SignedIn;
}) {
  const hydrated = useHydrated();
  const panel = useRef<HTMLElement>(null);
  const fileId = subject.kind === "file" ? subject.file.id : null;

  // Below the table on a phone, a selected file's details could be out of sight.
  useEffect(() => {
    if (fileId && window.matchMedia("(max-width: 899px)").matches) {
      panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (fileId) focusDetailsIfAsked();
  }, [fileId]);

  const changed = (timestamp: number | null) =>
    timestamp === null
      ? "Not yet"
      : hydrated
        ? formatChanged(timestamp, new Date())
        : " ";

  const facts: [string, string][] =
    subject.kind === "file"
      ? [
          ["Size", formatBytes(subject.file.size)],
          ["Changed", changed(subject.file.changedAt)],
          ["Added by", subject.addedBy],
        ]
      : [
          ["Contains", itemCount(subject.contains)],
          ["Changed", changed(subject.changedAt)],
          ["Created by", subject.createdBy],
        ];

  return (
    <aside
      ref={panel}
      id={detailsPanelId}
      tabIndex={-1}
      aria-label="Details"
      className={PANEL}
    >
      <div className="sticky top-3.5 flex flex-col gap-3">
        <div className="flex h-[124px] items-center justify-center overflow-hidden rounded bg-field text-secondary">
          {subject.kind === "file" ? (
            <FilePreview driveId={subject.driveId} file={subject.file} />
          ) : (
            <IconFolder size={38} stroke={1.75} aria-hidden />
          )}
        </div>
        <div className="flex items-start gap-1">
          <h2 className="min-w-0 flex-1 text-[15px] font-semibold break-words">
            {subject.kind === "file" ? subject.file.name : subject.name}
          </h2>
          {subject.kind === "file" ? (
            <StarButton driveId={subject.driveId} item={subject.file} />
          ) : (
            subject.driveId &&
            subject.folder && (
              <StarButton driveId={subject.driveId} item={subject.folder} />
            )
          )}
        </div>
        {subject.kind === "file" && (
          <div className="flex flex-wrap gap-1.5">
            {subject.canEdit && (
              <ShareButton driveId={subject.driveId} item={subject.file} />
            )}
            <a
              href={`/download/${subject.driveId}/${subject.file.id}`}
              className={buttonClass("toolbar")}
            >
              <IconDownload size={16} stroke={1.75} aria-hidden />
              Download
            </a>
            {subject.canEdit && (
              <ItemActions
                driveId={subject.driveId}
                item={subject.file}
                shared={subject.shared}
              />
            )}
          </div>
        )}
        {subject.kind === "folder" &&
          subject.driveId &&
          subject.folder &&
          subject.canEdit && (
            <div className="flex flex-wrap gap-1.5">
              <ShareButton driveId={subject.driveId} item={subject.folder} />
              <ItemActions
                driveId={subject.driveId}
                item={subject.folder}
                shared={subject.shared}
              />
            </div>
          )}
        {subject.kind === "folder" && subject.team && (
          <div className="flex flex-wrap gap-1.5">
            <TeamActions team={subject.team} me={me} />
          </div>
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
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-secondary">
            Who can open this
          </h3>
          <WhoCanOpen
            driveId={subject.driveId}
            itemId={
              subject.kind === "file"
                ? subject.file.id
                : (subject.folder?.id ?? null)
            }
            me={me}
          />
        </div>
      </div>
    </aside>
  );
}

export function NothingChosenPanel({
  message = "Choose a file to see its details.",
}: {
  message?: string;
}) {
  return (
    <aside id={detailsPanelId} aria-label="Details" className={PANEL}>
      <p className="mt-16 text-center text-sm text-secondary">{message}</p>
    </aside>
  );
}
