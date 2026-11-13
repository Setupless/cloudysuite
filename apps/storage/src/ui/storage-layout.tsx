import type { SignedIn } from "@cloudysuite/auth/session";
import { SuiteShell } from "@cloudysuite/auth/shell";
import {
  NAV_ITEM,
  NAV_ITEM_ACTIVE,
  useDestinationParam,
} from "@cloudysuite/ui";
import {
  IconHome,
  IconPlus,
  IconStar,
  IconTrash,
  IconUserCircle,
  IconUsers,
} from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { createTeamFolder, type Directory } from "../functions";
import { call, directoryQuery, refreshStorage } from "../queries";
import { formatBytes } from "./format";
import { StorageMeter } from "./storage-meter";
import { FolderLink, NameDialog, useFolderPrefetch } from "./page-parts";
import { SearchBox } from "./search-box";
import { teamColour } from "./team-colour";
import { UploadTray } from "./upload-tray";

const itemClass = (active: boolean) =>
  `${NAV_ITEM} ${active ? NAV_ITEM_ACTIVE : ""}`;

function useInMyFiles(directory: Directory | undefined) {
  const { pathname } = useLocation();
  const driveId = useDestinationParam("driveId");
  return (
    pathname.endsWith("/my-files") ||
    (driveId !== undefined && driveId === directory?.myDriveId)
  );
}

function Navigation({
  directory,
  onNewTeamFolder,
}: {
  directory: Directory | undefined;
  onNewTeamFolder: () => void;
}) {
  const { pathname } = useLocation();
  const driveId = useDestinationParam("driveId");
  const isHome = ["", "/storage"].includes(pathname.replace(/\/$/, ""));
  const isMyFiles = useInMyFiles(directory);
  const prefetchMyFiles = useFolderPrefetch(directory?.myDriveId ?? null, null);
  // Inside a drive that isn't on the person's list, they got there through a share.
  const isShared =
    pathname.endsWith("/shared") ||
    (driveId !== undefined &&
      directory !== undefined &&
      driveId !== directory.myDriveId &&
      !directory.teamFolders.some((folder) => folder.id === driveId));
  return (
    <>
      <Link
        to="/storage"
        activeOptions={{ exact: true }}
        className={itemClass(isHome)}
      >
        <IconHome size={18} stroke={1.75} aria-hidden />
        Home
      </Link>
      <Link
        to="/storage/my-files"
        className={itemClass(isMyFiles)}
        {...prefetchMyFiles}
      >
        <IconUserCircle size={18} stroke={1.75} aria-hidden />
        My files
      </Link>
      <Link to="/storage/shared" className={itemClass(isShared)}>
        <IconUsers size={18} stroke={1.75} aria-hidden />
        Shared with me
      </Link>
      <Link
        to="/storage/starred"
        className={itemClass(pathname.endsWith("/starred"))}
      >
        <IconStar size={18} stroke={1.75} aria-hidden />
        Starred
      </Link>
      <h3 className="px-2.5 pt-3 pb-1 text-xs font-semibold text-secondary">
        Team folders
      </h3>
      {directory?.teamFolders.map((folder) => (
        <FolderLink
          key={folder.id}
          driveId={folder.id}
          folderId={null}
          className={itemClass(driveId === folder.id)}
        >
          <span
            className={`mx-1 size-2.5 flex-none rounded-[3px] ${teamColour(folder.colour)}`}
            aria-hidden
          />
          <span className="min-w-0 truncate">{folder.name}</span>
        </FolderLink>
      ))}
      <button
        type="button"
        className={`${NAV_ITEM} cursor-pointer`}
        onClick={onNewTeamFolder}
      >
        <span className="flex items-center gap-2.5 text-secondary">
          <IconPlus size={18} stroke={1.75} aria-hidden />
          New team folder
        </span>
      </button>
      <Link
        to="/storage/trash"
        className={`${itemClass(pathname.endsWith("/trash"))} mt-2`}
      >
        <IconTrash size={18} stroke={1.75} aria-hidden />
        Trash
      </Link>
    </>
  );
}

function SidebarMeters({ directory }: { directory: Directory }) {
  const { usedBytes, limitBytes, myFiles } = directory;
  const inMyFiles = useInMyFiles(directory);
  return (
    <div className="flex flex-col gap-2 p-2.5">
      {inMyFiles && myFiles && (
        <StorageMeter
          usedBytes={myFiles.usedBytes}
          limitBytes={myFiles.limitBytes}
          text={`${formatBytes(myFiles.usedBytes)} of your ${formatBytes(myFiles.limitBytes)} used in My files`}
        />
      )}
      {limitBytes === null ? (
        <p className="text-xs text-secondary">
          {formatBytes(usedBytes)} of your organisation's storage used
        </p>
      ) : (
        <StorageMeter
          usedBytes={usedBytes}
          limitBytes={limitBytes}
          text={`${formatBytes(usedBytes)} of your organisation's ${formatBytes(limitBytes)} used`}
        />
      )}
    </div>
  );
}

function Shell({ user, children }: { user: SignedIn; children: ReactNode }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: directory } = useQuery(directoryQuery());
  const [naming, setNaming] = useState(false);
  return (
    <SuiteShell
      app="storage"
      user={user}
      navigationLabel="Storage"
      headerContent={<SearchBox />}
      navigation={
        <Navigation
          directory={directory}
          onNewTeamFolder={() => setNaming(true)}
        />
      }
      sidebarFooter={directory && <SidebarMeters directory={directory} />}
    >
      {children}
      <UploadTray />
      {naming && (
        <NameDialog
          title="New team folder"
          hint="You'll manage it, and you can add people once it's made."
          submitLabel="Create team folder"
          onSubmit={async (name) => {
            const driveId = await call(() =>
              createTeamFolder({ data: { name } }),
            );
            await refreshStorage(client);
            await navigate({
              to: "/storage/drive/$driveId",
              params: { driveId },
            });
          }}
          onClose={() => setNaming(false)}
        />
      )}
    </SuiteShell>
  );
}

export function StorageLayout({
  user,
  prefetched,
  children,
}: {
  user: SignedIn;
  prefetched: DehydratedState | undefined;
  children: ReactNode;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <Shell user={user}>{children}</Shell>
    </HydrationBoundary>
  );
}
