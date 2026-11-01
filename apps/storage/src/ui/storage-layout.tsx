import type { SignedIn } from "@cloudysuite/auth/session";
import { SuiteShell } from "@cloudysuite/auth/shell";
import { NAV_ITEM, NAV_ITEM_ACTIVE } from "@cloudysuite/ui";
import { IconHome, IconPlus, IconUserCircle } from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { createTeamFolder, type Directory } from "../functions";
import { call, directoryQuery, storageKeys } from "../queries";
import { formatBytes } from "./format";
import { NameDialog } from "./page-parts";
import { teamColour } from "./team-colour";
import { UploadTray } from "./upload-tray";

const itemClass = (active: boolean) =>
  `${NAV_ITEM} ${active ? NAV_ITEM_ACTIVE : ""}`;

function Navigation({
  directory,
  onNewTeamFolder,
}: {
  directory: Directory | undefined;
  onNewTeamFolder: () => void;
}) {
  const { pathname } = useLocation();
  const { driveId } = useParams({ strict: false });
  const myDriveId = directory?.myDriveId ?? null;
  const isHome = ["", "/storage"].includes(pathname.replace(/\/$/, ""));
  const isMyFiles =
    pathname.endsWith("/my-files") ||
    (driveId !== undefined && driveId === myDriveId);
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
      <Link to="/storage/my-files" className={itemClass(isMyFiles)}>
        <IconUserCircle size={18} stroke={1.75} aria-hidden />
        My files
      </Link>
      <h3 className="px-2.5 pt-3 pb-1 text-xs font-semibold text-secondary">
        Team folders
      </h3>
      {directory?.teamFolders.map((folder) => (
        <Link
          key={folder.id}
          to="/storage/drive/$driveId"
          params={{ driveId: folder.id }}
          className={itemClass(driveId === folder.id)}
        >
          <span
            className={`mx-1 size-2.5 flex-none rounded-[3px] ${teamColour(folder.colour)}`}
            aria-hidden
          />
          <span className="min-w-0 truncate">{folder.name}</span>
        </Link>
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
    </>
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
      navigation={
        <Navigation
          directory={directory}
          onNewTeamFolder={() => setNaming(true)}
        />
      }
      sidebarFooter={
        directory && (
          <p className="p-2.5 text-xs text-secondary">
            {formatBytes(directory.usedBytes)} of your organisation's storage
            used
          </p>
        )
      }
    >
      {children}
      <UploadTray />
      {naming && (
        <NameDialog
          title="New team folder"
          hint="Only you can open it for now."
          submitLabel="Create team folder"
          onSubmit={async (name) => {
            const driveId = await call(() =>
              createTeamFolder({ data: { name } }),
            );
            await client.invalidateQueries({ queryKey: storageKeys.all });
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
