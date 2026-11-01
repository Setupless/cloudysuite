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
import { useNavigate } from "@tanstack/react-router";
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
  storageKeys,
} from "../queries";
import { type ItemId, parseItemId } from "../types";
import {
  DetailsPanel,
  type PanelAccess,
  type PanelSubject,
} from "./details-panel";
import { FileTable } from "./file-table";
import {
  Breadcrumb,
  DropZone,
  FolderLink,
  PageActions,
  PageTop,
  Problem,
  SkipToDetails,
} from "./page-parts";
import { personOf } from "./people";
import type { Destination } from "./upload-queue";

function EmptyFolder() {
  return (
    <div className="mx-auto my-[60px] flex max-w-[280px] flex-col items-center gap-2 text-center text-sm text-secondary">
      <IconFolder size={30} stroke={1.75} aria-hidden />
      <strong className="font-semibold text-text">This folder is empty</strong>
      <span>Drop files here or choose Upload.</span>
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
    await client.invalidateQueries({ queryKey: storageKeys.all });
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
  if (!first) return null;

  const title = first.folder?.name ?? first.drive.name;
  const destination: Destination = {
    kind: "folder",
    driveId,
    folderId,
    name: title,
  };
  const selected =
    listed?.kind === "file"
      ? { file: listed, people }
      : selectedId !== null
        ? fetched.data
        : null;
  const access: PanelAccess =
    first.drive.kind === "personal"
      ? { kind: "personal", me }
      : { kind: "team", name: first.drive.name, colour: first.drive.colour };
  const subject: PanelSubject = selected
    ? {
        kind: "file",
        driveId,
        file: selected.file,
        addedBy: personOf(selected.people, selected.file.createdBy).name,
      }
    : {
        kind: "folder",
        name: title,
        contains: first.contains,
        changedAt: first.folder?.changedAt ?? first.drive.changedAt,
        createdBy: personOf(
          people,
          first.folder?.createdBy ?? first.driveCreatedBy ?? "",
        ).name,
        actionable: first.folder ? { driveId, folder: first.folder } : null,
      };

  const isDriveRoot = folderId === null;
  const trail = [
    ...(isDriveRoot
      ? []
      : [
          {
            key: driveId,
            link: (
              <FolderLink driveId={driveId} folderId={null}>
                {first.drive.name}
              </FolderLink>
            ),
          },
        ]),
    ...first.ancestors.map((ancestor) => ({
      key: ancestor.id,
      link: (
        <FolderLink driveId={driveId} folderId={ancestor.id}>
          {ancestor.name}
        </FolderLink>
      ),
    })),
  ];

  return (
    <DropZone destination={destination} className={SCREEN}>
      <div className="min-w-0 flex-1 pb-4">
        <Breadcrumb trail={trail} current={title} />
        <PageTop title={title}>
          <PageActions destination={destination} onNewFolder={createFolder} />
        </PageTop>
        {first.folder && <SkipToDetails />}
        {items.length === 0 ? (
          <EmptyFolder />
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
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Show more
            </Button>
          </div>
        )}
      </div>
      <DetailsPanel subject={subject} access={access} />
    </DropZone>
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
              await client.invalidateQueries({ queryKey: storageKeys.all });
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
          actionable: null,
        }}
        access={{ kind: "personal", me }}
      />
    </DropZone>
  );
}
