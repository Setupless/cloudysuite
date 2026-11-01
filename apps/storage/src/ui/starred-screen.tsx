import type { SignedIn } from "@cloudysuite/auth/session";
import { Notice } from "@cloudysuite/ui";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { starredQuery } from "../queries";
import { parseItemId } from "../types";
import { DetailsPanel, NothingChosenPanel } from "./details-panel";
import { FileTable } from "./file-table";
import { Breadcrumb, PageTop, Problem } from "./page-parts";
import { personOf } from "./people";

function Starred({ me, file }: { me: SignedIn; file: string | undefined }) {
  const navigate = useNavigate();
  const query = useQuery(starredQuery());
  const selectedId = file ? parseItemId(file) : null;
  if (query.isError) return <Problem message={query.error.message} />;
  if (!query.data) return null;
  const { rows, incomplete, people } = query.data;
  const selected = rows.find(
    (row) => row.item.kind === "file" && row.item.id === selectedId,
  );

  return (
    <div className="flex min-h-[calc(100dvh-52px)] max-[899px]:flex-col">
      <div className="min-w-0 flex-1 pb-4">
        <Breadcrumb trail={[]} current="Starred" />
        <PageTop title="Starred" />
        {incomplete && (
          <div className="px-4 pb-2.5">
            <Notice tone="info">
              Some folders couldn't be checked for stars. Try again in a moment.
            </Notice>
          </div>
        )}
        {rows.length === 0 ? (
          !incomplete && (
            <p className="px-4 text-sm text-secondary">
              Nothing here yet. Choose the star beside a file or folder to find
              it here quickly. Only you see your stars.
            </p>
          )
        ) : (
          <FileTable
            rows={rows.map((row) => ({
              driveId: row.driveId,
              item: row.item,
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
      {selected?.item.kind === "file" ? (
        <DetailsPanel
          subject={{
            kind: "file",
            driveId: selected.driveId,
            file: selected.item,
            addedBy: personOf(people, selected.item.createdBy).name,
            canEdit: selected.canEdit,
            shared: selected.shared,
          }}
          me={me}
        />
      ) : (
        rows.length > 0 && <NothingChosenPanel />
      )}
    </div>
  );
}

export function StarredScreen({
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
      <Starred me={me} file={file} />
    </HydrationBoundary>
  );
}
