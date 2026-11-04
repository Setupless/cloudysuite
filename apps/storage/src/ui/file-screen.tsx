import { type DriveId, parseDriveId } from "@cloudysuite/access";
import type { SignedIn } from "@cloudysuite/auth/session";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { fileQuery } from "../queries";
import { type ItemId, parseItemId } from "../types";
import { DetailsPanel } from "./details-panel";
import { FileTable } from "./file-table";
import { Breadcrumb, LoadingPage, PageTop, Problem } from "./page-parts";
import { personOf } from "./people";

const CANNOT_OPEN =
  "You can't open this file. It may have been moved or deleted, or it may not be shared with you. Ask the person who sent you the link.";

// A link to one file has to work for someone who can reach only that file, so it can't
// point into the folder around it. Anyone who can see the folder goes to it.
function File({
  me,
  driveId,
  fileId,
}: {
  me: SignedIn;
  driveId: DriveId;
  fileId: ItemId;
}) {
  const navigate = useNavigate();
  const query = useQuery(fileQuery(driveId, fileId));
  const opened = query.data;
  const parentId = opened?.file.parentId ?? null;
  const showFolder = opened && (!opened.shared || parentId !== null);

  useEffect(() => {
    if (!showFolder) return;
    void (parentId === null
      ? navigate({
          to: "/storage/drive/$driveId",
          params: { driveId },
          search: { file: fileId },
          replace: true,
        })
      : navigate({
          to: "/storage/drive/$driveId/$folderId",
          params: { driveId, folderId: parentId },
          search: { file: fileId },
          replace: true,
        }));
  }, [showFolder, parentId, driveId, fileId, navigate]);

  if (query.isError || query.data === null) {
    return <Problem message={query.error?.message ?? CANNOT_OPEN} />;
  }
  if (!opened || showFolder) return <LoadingPage />;
  return (
    <div className="flex min-h-[calc(100dvh-52px)] max-[899px]:flex-col">
      <div className="min-w-0 flex-1 pb-4">
        <Breadcrumb
          trail={[
            {
              key: "shared",
              link: <Link to="/storage/shared">Shared with me</Link>,
            },
          ]}
          current={opened.file.name}
        />
        <PageTop title={opened.file.name} />
        <FileTable
          rows={[{ driveId, item: opened.file }]}
          people={opened.people}
          selectedId={fileId}
          onSelect={() => {}}
        />
      </div>
      <DetailsPanel
        subject={{
          kind: "file",
          driveId,
          file: opened.file,
          addedBy: personOf(opened.people, opened.file.createdBy).name,
          canEdit: opened.canEdit,
          shared: true,
        }}
        me={me}
      />
    </div>
  );
}

export function FileScreen({
  me,
  driveId: rawDriveId,
  fileId: rawFileId,
  prefetched,
}: {
  me: SignedIn;
  driveId: string;
  fileId: string;
  prefetched: DehydratedState | undefined;
}) {
  const driveId = parseDriveId(rawDriveId);
  const fileId = parseItemId(rawFileId);
  if (!driveId || !fileId) return <Problem message={CANNOT_OPEN} />;
  return (
    <HydrationBoundary state={prefetched}>
      <File me={me} driveId={driveId} fileId={fileId} />
    </HydrationBoundary>
  );
}
