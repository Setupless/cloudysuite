import type { DriveId } from "@cloudysuite/access";
import { parseDriveId } from "@cloudysuite/access";
import type { SignedIn } from "@cloudysuite/auth/session";
import { Button } from "@cloudysuite/ui";
import { IconFolder } from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  createFolder as createFolderOnServer,
  ensureMyFiles,
  type People,
} from "../functions";
import {
  call,
  directoryQuery,
  fileQuery,
  folderQuery,
  refreshStorage,
} from "../queries";
import { type ItemId, parseItemId } from "../types";
import { DetailsPanel, type PanelSubject } from "./details-panel";
import { FileTable } from "./file-table";
import {
  Breadcrumb,
  DropZone,
  FolderLink,
  LoadingPage,
  PageActions,
  PageTop,
  Problem,
  SkipToDetails,
} from "./page-parts";
import { personOf } from "./people";
import type { Destination } from "./upload-queue";

function EmptyFolder({ canEdit = true }: { canEdit?: boolean }) {
  return (
    <div className="mx-auto my-[60px] flex max-w-[280px] flex-col items-center gap-2 text-center text-sm text-secondary">
      <IconFolder size={30} stroke={1.75} aria-hidden />
      <strong className="font-semibold text-text">This folder is empty</strong>
      {canEdit && <span>Drop files here or choose Upload.</span>}
    </div>
  );
}

const SCREEN = "flex min-h-[calc(100dvh-52px)] max-[899px]:flex-col";

export function useCreateFolderIn(driveId: DriveId, parentId: ItemId | null) {
  const client = useQueryClient();
  return async (name: string) => {
    await call(() =>
      createFolderOnServer({ data: { driveId, parentId, name } }),
    );
    await refreshStorage(client);
  };
}

function Folder({
  me,
  driveId,
  folderId,
  selectedId,
}: {
  me: SignedIn;
  driveId: DriveId;
  folderId: ItemId | null;
  selectedId: ItemId | null;
}) {
  const navigate = useNavigate();
  const query = useInfiniteQuery(folderQuery(driveId, folderId));
  const createFolder = useCreateFolderIn(driveId, folderId);
  const first = query.data?.pages[0];
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const people: People = Object.assign(
    {},
    ...(query.data?.pages.map((page) => page.people) ?? []),
  );
  const listed = items.find(
    (item) => item.kind === "file" && item.id === selectedId,
  );
  const fetched = useQuery({
    ...fileQuery(driveId, selectedId as ItemId),
    enabled: selectedId !== null && first !== undefined && !listed,
  });

  if (query.isError) return <Problem message={query.error.message} />;
  if (!first) return <LoadingPage />;

  const { place } = first;
  const title =
    first.folder?.name ?? (place.kind === "drive" ? place.drive.name : "");
  const destination: Destination = {
    kind: "folder",
    driveId,
    folderId,
    name: title,
  };
  const selected =
    listed?.kind === "file"
      ? {
          file: listed,
          people,
          canEdit: first.canEdit || first.editableIds.includes(listed.id),
        }
      : selectedId !== null
        ? fetched.data
        : null;
  const subject: PanelSubject = selected
    ? {
        kind: "file",
        driveId,
        file: selected.file,
        addedBy: personOf(selected.people, selected.file.createdBy).name,
        canEdit: selected.canEdit,
        shared: first.shared,
      }
    : {
        kind: "folder",
        name: title,
        contains: first.contains,
        changedAt:
          first.folder?.changedAt ??
          (place.kind === "drive" ? place.drive.changedAt : null),
        createdBy: personOf(
          people,
          first.folder?.createdBy ??
            (place.kind === "drive" ? place.driveCreatedBy : null) ??
            "",
        ).name,
        driveId,
        folder: first.folder,
        team:
          place.kind === "drive" &&
          place.drive.kind === "team" &&
          first.folder === null
            ? {
                driveId,
                name: place.drive.name,
                role: place.role,
              }
            : null,
        canEdit: first.canEdit,
        shared: first.shared,
      };

  const isDriveRoot = folderId === null;
  // Above a share, nothing has a name this person may see.
  const start =
    place.kind === "shared"
      ? [
          {
            key: "shared",
            link: <Link to="/storage/shared">Shared with me</Link>,
          },
        ]
      : isDriveRoot
        ? []
        : [
            {
              key: driveId,
              link: (
                <FolderLink driveId={driveId} folderId={null}>
                  {place.drive.name}
                </FolderLink>
              ),
            },
          ];
  const trail = [
    ...start,
    ...first.ancestors.map((ancestor) => ({
      key: ancestor.id,
      link: (
        <FolderLink driveId={driveId} folderId={ancestor.id}>
          {ancestor.name}
        </FolderLink>
      ),
    })),
  ];

  const contents = (
    <>
      <div className="min-w-0 flex-1 pb-4">
        <Breadcrumb trail={trail} current={title} />
        <PageTop title={title}>
          {first.canEdit && (
            <PageActions destination={destination} onNewFolder={createFolder} />
          )}
        </PageTop>
        {first.folder && first.canEdit && <SkipToDetails />}
        {items.length === 0 ? (
          <EmptyFolder canEdit={first.canEdit} />
        ) : (
          <FileTable
            rows={items.map((item) => ({ driveId, item }))}
            people={people}
            selectedId={selectedId}
            onSelect={(id) =>
              void navigate({
                to: ".",
                search: { file: id === selectedId ? undefined : id },
                replace: true,
                resetScroll: false,
              })
            }
          />
        )}
        {query.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="quiet"
              pending={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Show more
            </Button>
          </div>
        )}
      </div>
      <DetailsPanel subject={subject} me={me} />
    </>
  );
  return first.canEdit ? (
    <DropZone destination={destination} className={SCREEN}>
      {contents}
    </DropZone>
  ) : (
    <div className={SCREEN}>{contents}</div>
  );
}

export function FolderScreen({
  me,
  driveId: rawDriveId,
  folderId: rawFolderId,
  file,
  prefetched,
}: {
  me: SignedIn;
  driveId: string;
  folderId?: string;
  file?: string;
  prefetched: DehydratedState | undefined;
}) {
  const driveId = parseDriveId(rawDriveId);
  const folderId = rawFolderId === undefined ? null : parseItemId(rawFolderId);
  if (!driveId || (rawFolderId !== undefined && !folderId)) {
    return (
      <Problem message="We can't find that folder. It may no longer exist." />
    );
  }
  return (
    <HydrationBoundary state={prefetched}>
      <Folder
        key={`${driveId}/${folderId}`}
        me={me}
        driveId={driveId}
        folderId={folderId}
        selectedId={file ? parseItemId(file) : null}
      />
    </HydrationBoundary>
  );
}

// Until the first folder or file, My files doesn't exist yet. It looks like any other
// empty folder, and adding something makes it and moves here to its real address.
export function MyFilesScreen({ me }: { me: SignedIn }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery(directoryQuery());
  const myDriveId = data?.myDriveId ?? null;

  useEffect(() => {
    if (myDriveId) {
      void navigate({
        to: "/storage/drive/$driveId",
        params: { driveId: myDriveId },
        replace: true,
      });
    }
  }, [myDriveId, navigate]);

  const title = "My files";
  const destination: Destination = { kind: "myFiles" };
  return (
    <DropZone destination={destination} className={SCREEN}>
      <div className="min-w-0 flex-1 pb-4">
        <Breadcrumb trail={[]} current={title} />
        <PageTop title={title}>
          <PageActions
            destination={destination}
            onNewFolder={async (name) => {
              const driveId = await call(() => ensureMyFiles());
              await call(() =>
                createFolderOnServer({
                  data: { driveId, parentId: null, name },
                }),
              );
              await refreshStorage(client);
            }}
          />
        </PageTop>
        <EmptyFolder />
      </div>
      <DetailsPanel
        subject={{
          kind: "folder",
          name: title,
          contains: 0,
          changedAt: null,
          createdBy: me.name,
          driveId: null,
          folder: null,
          team: null,
          canEdit: true,
          shared: false,
        }}
        me={me}
      />
    </DropZone>
  );
}
