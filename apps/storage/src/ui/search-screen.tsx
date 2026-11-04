import { Notice, useHydrated } from "@cloudysuite/ui";
import { IconFolder } from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { SearchRow } from "../across-drives";
import { searchQuery } from "../queries";
import { parseSearch } from "../search-query";
import { FileIcon } from "./file-visuals";
import { formatBytes, formatChanged, itemCount } from "./format";
import {
  FolderLink,
  Breadcrumb,
  LoadingRows,
  PageTop,
  Problem,
} from "./page-parts";
import { StarButton } from "./star-button";

const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_60px_28px] items-center gap-2.5 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_84px_60px_28px]";
const OPTIONAL_COLUMN = "max-sm:hidden";
const ROW = `${COLUMNS} mx-2 w-[calc(100%-1rem)] cursor-pointer rounded px-2.5 py-[7px] text-left text-sm outline-accent hover:bg-field focus-visible:outline-2`;

const locationOf = ({ driveName, location }: SearchRow) =>
  [driveName ?? "Shared with me", ...location].join(" › ");

// Opening a result goes to where it lives. A file shared on its own has no folder this
// person can open, so it opens on its own page.
function ResultLink({
  row,
  children,
}: {
  row: SearchRow;
  children: ReactNode;
}) {
  const { driveId, item, driveName } = row;
  if (item.kind === "folder") {
    return (
      <FolderLink driveId={driveId} folderId={item.id} className={ROW}>
        {children}
      </FolderLink>
    );
  }
  if (item.parentId === null && driveName === null) {
    return (
      <Link
        to="/storage/file/$driveId/$fileId"
        params={{ driveId, fileId: item.id }}
        className={ROW}
      >
        {children}
      </Link>
    );
  }
  return (
    <FolderLink
      driveId={driveId}
      folderId={item.parentId}
      file={item.id}
      className={ROW}
    >
      {children}
    </FolderLink>
  );
}

function ResultRow({ row, changed }: { row: SearchRow; changed: string }) {
  const { item, driveId } = row;
  const location = locationOf(row);
  return (
    <div className="relative">
      <ResultLink row={row}>
        <span className="flex min-w-0 items-center gap-[9px]">
          <span
            className={`flex-none ${item.kind === "folder" ? "text-accent" : "text-secondary"}`}
          >
            {item.kind === "folder" ? (
              <IconFolder size={18} stroke={1.75} aria-hidden />
            ) : (
              <FileIcon file={item} />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate">{item.name}</span>
            <span className="block truncate text-xs text-secondary sm:hidden">
              {location}
            </span>
          </span>
        </span>
        <span
          className={`truncate text-[13px] text-secondary ${OPTIONAL_COLUMN}`}
          title={location}
        >
          {location}
        </span>
        <span
          className={`truncate text-[13px] text-secondary ${OPTIONAL_COLUMN}`}
        >
          {changed}
        </span>
        <span className="truncate text-[13px] text-secondary">
          {item.kind === "folder"
            ? itemCount(item.contains)
            : formatBytes(item.size)}
        </span>
        <span />
      </ResultLink>
      <span className="absolute top-1/2 right-[18px] flex -translate-y-1/2">
        <StarButton driveId={driveId} item={item} />
      </span>
    </div>
  );
}

const Hint = ({ children }: { children: ReactNode }) => (
  <p className="px-4 text-sm text-secondary">{children}</p>
);

function Results({ text }: { text: string }) {
  // Only whether it parses: the server reads it again with the reader's time zone.
  const parsed = parseSearch(text, 0);
  const query = useQuery({ ...searchQuery(text), enabled: parsed.ok });
  // The server knows neither the reader's time zone nor their language.
  const hydrated = useHydrated();
  const now = new Date();

  if (!parsed.ok) return <Hint>{parsed.problem}</Hint>;
  if (query.isError) return <Problem message={query.error.message} />;
  if (!query.data) return <LoadingRows />;
  if (query.data.status === "problem") return <Hint>{query.data.problem}</Hint>;
  const { rows, more, incomplete } = query.data;

  return (
    <>
      {incomplete && (
        <div className="px-4 pb-2.5">
          <Notice tone="info">
            Some folders couldn't be searched. Try again in a moment.
          </Notice>
        </div>
      )}
      {rows.length === 0 ? (
        !incomplete && (
          <p className="px-4 text-sm text-secondary">
            Nothing matches that. Check the spelling, or try fewer words. Search
            looks at names, not what's inside files.
          </p>
        )
      ) : (
        <div>
          <div
            className={`${COLUMNS} mx-4 border-b border-line px-0.5 py-[7px] text-xs font-semibold text-secondary`}
          >
            <span>Name</span>
            <span className={OPTIONAL_COLUMN}>Location</span>
            <span className={OPTIONAL_COLUMN}>Changed</span>
            <span>Size</span>
            <span />
          </div>
          <div className="flex flex-col">
            {rows.map((row) => (
              <ResultRow
                key={`${row.driveId}/${row.item.id}`}
                row={row}
                changed={
                  hydrated ? formatChanged(row.item.changedAt, now) : " "
                }
              />
            ))}
          </div>
          {more && (
            <p className="px-4 pt-3 text-[13px] text-secondary">
              These are the most recently changed matches. Add another word to
              narrow them down.
            </p>
          )}
        </div>
      )}
    </>
  );
}

export function SearchScreen({
  text,
  prefetched,
}: {
  text: string;
  prefetched: DehydratedState | undefined;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <div className="min-h-[calc(100dvh-52px)] pb-4">
        <Breadcrumb trail={[]} current="Search" />
        <PageTop title="Search" />
        <Results text={text} />
      </div>
    </HydrationBoundary>
  );
}
