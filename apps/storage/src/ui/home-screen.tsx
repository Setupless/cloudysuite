import { Avatar, useHydrated } from "@cloudysuite/ui";
import { IconFolder } from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  createFolder,
  ensureMyFiles,
  type People,
  type RecentFile,
  type TeamFolderCard,
} from "../functions";
import { call, directoryQuery, recentQuery, refreshStorage } from "../queries";
import { FilePreview } from "./file-visuals";
import { folderSummary, formatChanged } from "./format";
import { MailAttachments } from "./mail-attachments";
import {
  BONE,
  DropZone,
  FolderLink,
  Loading,
  PageActions,
  PageTop,
} from "./page-parts";
import { personOf } from "./people";
import { teamColour } from "./team-colour";

function TeamCard({ folder }: { folder: TeamFolderCard }) {
  const hydrated = useHydrated();
  return (
    <Link
      to="/storage/drive/$driveId"
      params={{ driveId: folder.id }}
      className="flex min-w-0 flex-col gap-2 rounded border border-line p-3 outline-accent hover:bg-field focus-visible:outline-2"
    >
      <span className="flex min-w-0 items-center gap-2 font-semibold">
        <span
          className={`flex size-[30px] flex-none items-center justify-center rounded text-on-avatar ${teamColour(folder.colour)}`}
        >
          <IconFolder size={16} stroke={1.75} aria-hidden />
        </span>
        <span className="truncate">{folder.name}</span>
      </span>
      <span className="flex items-center justify-between gap-1.5 text-[13px] text-secondary">
        <span className="truncate">
          {hydrated
            ? folderSummary(folder.fileCount, folder.changedAt, new Date())
            : " "}
        </span>
        <span className="flex flex-none">
          {folder.members.map((member) => (
            <span
              key={member.id}
              title={member.name}
              className="-ml-[3px] rounded-full ring-2 ring-page first:ml-0"
            >
              <Avatar person={member} size="small" />
            </span>
          ))}
        </span>
      </span>
    </Link>
  );
}

function RecentCard({
  recent,
  people,
}: {
  recent: RecentFile;
  people: People;
}) {
  const hydrated = useHydrated();
  const { file, drive } = recent;
  return (
    <FolderLink
      driveId={drive.id}
      folderId={file.parentId}
      file={file.id}
      className="block min-w-0 overflow-hidden rounded border border-line outline-accent hover:bg-field focus-visible:outline-2"
    >
      <span className="flex h-[92px] items-center justify-center overflow-hidden bg-field text-secondary">
        <FilePreview driveId={drive.id} file={file} />
      </span>
      <span className="block px-[9px] py-[7px] text-[13px]">
        <span className="block truncate">{file.name}</span>
        <span className="block truncate text-xs text-secondary">
          {personOf(people, file.createdBy).name}
          {hydrated ? `, ${formatChanged(file.changedAt, new Date())}` : ""}
        </span>
      </span>
    </FolderLink>
  );
}

function Home({ mailHref }: { mailHref: string | undefined }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const directory = useQuery(directoryQuery());
  const recent = useQuery(recentQuery(4));
  const teamFolders = directory.data?.teamFolders ?? [];
  const files = recent.data?.files ?? [];

  return (
    <DropZone
      destination={{ kind: "myFiles" }}
      className="min-h-[calc(100dvh-52px)] pb-4"
    >
      <PageTop title="Home">
        <PageActions
          destination={{ kind: "myFiles" }}
          onNewFolder={async (name) => {
            const driveId = await call(() => ensureMyFiles());
            await call(() =>
              createFolder({ data: { driveId, parentId: null, name } }),
            );
            await refreshStorage(client);
            await navigate({
              to: "/storage/drive/$driveId",
              params: { driveId },
            });
          }}
        />
      </PageTop>
      {teamFolders.length > 0 ? (
        <div className="grid grid-cols-1 gap-2.5 px-4 sm:grid-cols-3">
          {teamFolders.map((folder) => (
            <TeamCard key={folder.id} folder={folder} />
          ))}
        </div>
      ) : directory.data ? (
        <p className="px-4 text-sm text-secondary">
          No team folders yet. Choose New team folder to make one.
        </p>
      ) : (
        directory.isPending && (
          <Loading className="grid grid-cols-1 gap-2.5 px-4 sm:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <span key={index} aria-hidden className={`h-[78px] ${BONE}`} />
            ))}
          </Loading>
        )
      )}
      <div className="flex items-center px-4 pt-4 pb-2 text-sm font-semibold">
        <h2>Recent</h2>
        {files.length > 0 && (
          <Link
            to="/storage/recent"
            className="ml-auto text-[13px] font-normal text-accent"
          >
            See all
          </Link>
        )}
      </div>
      {recent.isError ? (
        <p role="alert" className="px-4 text-sm text-danger">
          {recent.error.message}
        </p>
      ) : files.length > 0 ? (
        <div className="grid grid-cols-2 gap-2.5 px-4 sm:grid-cols-4">
          {files.map((item) => (
            <RecentCard
              key={item.file.id}
              recent={item}
              people={recent.data?.people ?? {}}
            />
          ))}
        </div>
      ) : recent.data ? (
        <p className="px-4 text-sm text-secondary">
          Files you and your team add will show up here.
        </p>
      ) : (
        <Loading className="grid grid-cols-2 gap-2.5 px-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} aria-hidden className={`h-[136px] ${BONE}`} />
          ))}
        </Loading>
      )}
      {mailHref && <MailAttachments mailHref={mailHref} />}
    </DropZone>
  );
}

export function HomeScreen({
  prefetched,
  mailHref,
}: {
  prefetched: DehydratedState | undefined;
  mailHref: string | undefined;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <Home mailHref={mailHref} />
    </HydrationBoundary>
  );
}
