import type { DriveId } from "@cloudysuite/access";
import { Avatar, buttonClass, useHydrated } from "@cloudysuite/ui";
import type { SignedIn } from "@cloudysuite/auth/session";
import { IconDownload, IconFolder, IconUsers } from "@tabler/icons-react";
import { useEffect, useRef } from "react";
import type { FileItem, FolderItem } from "../types";
import { detailsPanelId, focusDetailsIfAsked } from "./details-focus";
import { FilePreview } from "./file-visuals";
import { formatBytes, formatChanged, itemCount } from "./format";
import { ItemActions } from "./item-actions";
import { teamColour } from "./team-colour";

// Who can open this comes from the drive. A personal drive is only ever its owner.
export type PanelAccess =
  | { kind: "personal"; me: SignedIn }
  | { kind: "team"; name: string; colour: number };

export type PanelSubject =
  | {
      kind: "folder";
      name: string;
      contains: number;
      changedAt: number | null;
      createdBy: string;
      // Null for a drive's root, which is not an item and has no actions.
      actionable: { driveId: DriveId; folder: FolderItem } | null;
    }
  | { kind: "file"; driveId: DriveId; file: FileItem; addedBy: string };

export const PANEL =
  "flex-none border-line p-3.5 outline-none max-[899px]:border-t min-[900px]:w-[262px] min-[900px]:border-l";

function AccessRow({ access }: { access: PanelAccess }) {
  return (
    <div className="flex items-center gap-2 text-[13px]">
      {access.kind === "personal" ? (
        <Avatar person={access.me} size="small" />
      ) : (
        <span
          className={`flex size-[22px] flex-none items-center justify-center rounded-full text-on-avatar ${teamColour(access.colour)}`}
        >
          <IconUsers size={13} stroke={1.75} aria-hidden />
        </span>
      )}
      <span className="min-w-0 truncate">
        {access.kind === "personal" ? "Only you" : `${access.name} team`}
      </span>
      <em className="ml-auto text-xs text-secondary not-italic">
        {access.kind === "personal" ? "Owner" : "Can edit"}
      </em>
    </div>
  );
}

export function DetailsPanel({
  subject,
  access,
}: {
  subject: PanelSubject;
  access: PanelAccess;
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
        <h2 className="text-[15px] font-semibold break-words">
          {subject.kind === "file" ? subject.file.name : subject.name}
        </h2>
        {subject.kind === "file" && (
          <div className="flex flex-wrap gap-1.5">
            <a
              href={`/download/${subject.driveId}/${subject.file.id}`}
              download
              className={buttonClass("toolbar")}
            >
              <IconDownload size={16} stroke={1.75} aria-hidden />
              Download
            </a>
            <ItemActions driveId={subject.driveId} item={subject.file} />
          </div>
        )}
        {subject.kind === "folder" && subject.actionable && (
          <div className="flex flex-wrap gap-1.5">
            <ItemActions
              driveId={subject.actionable.driveId}
              item={subject.actionable.folder}
            />
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
          <AccessRow access={access} />
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
