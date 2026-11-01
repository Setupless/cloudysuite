import type { SignedIn } from "@cloudysuite/auth/session";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { recentQuery } from "../queries";
import { parseItemId } from "../types";
import { levelOfRole } from "@cloudysuite/access";
import { DetailsPanel, NothingChosenPanel } from "./details-panel";
import { FileTable } from "./file-table";
import { Breadcrumb, PageTop, Problem } from "./page-parts";
import { personOf } from "./people";

function Recent({ me, file }: { me: SignedIn; file: string | undefined }) {
  const navigate = useNavigate();
  const query = useQuery(recentQuery(50));
  const selectedId = file ? parseItemId(file) : null;
  if (query.isError) return <Problem message={query.error.message} />;
  if (!query.data) return null;
  const { files, people } = query.data;
  const selected = files.find((item) => item.file.id === selectedId);

  return (
    <div className="flex min-h-[calc(100dvh-52px)] max-[899px]:flex-col">
      <div className="min-w-0 flex-1 pb-4">
        <Breadcrumb trail={[]} current="Recent" />
        <PageTop title="Recent" />
        {files.length === 0 ? (
          <p className="px-4 text-sm text-secondary">
            Files you and your team add will show up here.
          </p>
        ) : (
          <FileTable
            rows={files.map(({ file: item, drive }) => ({
              driveId: drive.id,
              item,
            }))}
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
      </div>
      {selected ? (
        <DetailsPanel
          subject={{
            kind: "file",
            driveId: selected.drive.id,
            file: selected.file,
            addedBy: personOf(people, selected.file.createdBy).name,
            canEdit: levelOfRole(selected.drive.role) === "edit",
            shared: false,
          }}
          me={me}
        />
      ) : (
        files.length > 0 && <NothingChosenPanel />
      )}
    </div>
  );
}

export function RecentScreen({
  me,
  file,
  prefetched,
}: {
  me: SignedIn;
  file: string | undefined;
  prefetched: DehydratedState | undefined;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <Recent me={me} file={file} />
    </HydrationBoundary>
  );
}
