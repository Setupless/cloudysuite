import type { SignedIn } from "@cloudysuite/auth/session";
import { PrefetchedData } from "@cloudysuite/page-data";
import { type DehydratedState, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { sharedQuery } from "../queries";
import { parseItemId } from "../types";
import { DetailsPanel, NothingChosenPanel } from "./details-panel";
import { FileTable } from "./file-table";
import { Breadcrumb, LoadingPage, PageTop, Problem } from "./page-parts";
import { personOf } from "./people";

function Shared({ me, file }: { me: SignedIn; file: string | undefined }) {
  const navigate = useNavigate();
  const query = useQuery(sharedQuery());
  const selectedId = file ? parseItemId(file) : null;
  if (query.isError) return <Problem message={query.error.message} />;
  if (!query.data) return <LoadingPage title="Shared with me" />;
  const { rows, people } = query.data;
  const selected = rows.find(
    (row) => row.item.kind === "file" && row.item.id === selectedId,
  );

  return (
    <div className="flex min-h-[calc(100dvh-52px)] max-[899px]:flex-col">
      <div className="min-w-0 flex-1 pb-4">
        <Breadcrumb trail={[]} current="Shared with me" />
        <PageTop title="Shared with me" />
        {rows.length === 0 ? (
          <p className="px-4 text-sm text-secondary">
            Nothing here yet. When someone shares a file or folder with you, it
            shows up here.
          </p>
        ) : (
          <FileTable
            dateLabel="Shared"
            rows={rows.map((row) => ({
              driveId: row.driveId,
              item: row.item,
              person: row.sharedBy,
              at: row.sharedAt,
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
            canRename: selected.canRename,
            shared: true,
          }}
          me={me}
        />
      ) : (
        rows.length > 0 && <NothingChosenPanel />
      )}
    </div>
  );
}

export function SharedScreen({
  me,
  file,
  prefetched,
}: {
  me: SignedIn;
  file: string | undefined;
  prefetched: DehydratedState | undefined;
}) {
  return (
    <PrefetchedData state={prefetched}>
      <Shared me={me} file={file} />
    </PrefetchedData>
  );
}
