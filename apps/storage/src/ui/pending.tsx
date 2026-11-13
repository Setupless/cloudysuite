import { Bone, PageSkeleton } from "@cloudysuite/ui/skeleton";
import { IconChevronRight } from "@tabler/icons-react";

// What a page shows while it opens. Each matches the page's own loading state, so the
// hand-over from one to the other doesn't jump.

const ROW_WIDTHS = ["w-2/5", "w-1/3", "w-1/2", "w-1/4", "w-2/5", "w-1/3"];

export function FileRows() {
  return ROW_WIDTHS.map((width, index) => (
    <span
      key={index}
      aria-hidden
      className="flex items-center gap-[9px] border-b border-line px-0.5 py-[9px]"
    >
      <Bone className="size-[18px] flex-none" />
      <Bone className={`h-3 ${width}`} />
    </span>
  ));
}

function Title({ children }: { children: string }) {
  return (
    <p className="px-4 pt-3.5 pb-2.5 text-[21px] font-semibold">{children}</p>
  );
}

function Rows() {
  return (
    <div className="flex flex-col px-4 pt-2">
      <FileRows />
    </div>
  );
}

export function HomePending() {
  return (
    <PageSkeleton className="min-h-[calc(100dvh-52px)] pb-4">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <p className="mr-auto text-[21px] font-semibold">Home</p>
        <Bone className="h-[38px] w-24" />
        <Bone className="h-[38px] w-32" />
      </div>
      <div className="grid grid-cols-1 gap-2.5 px-4 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Bone key={index} className="h-[78px]" />
        ))}
      </div>
      <p className="px-4 pt-4 pb-2 text-sm font-semibold">Recent</p>
      <div className="grid grid-cols-2 gap-2.5 px-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Bone key={index} className="h-[136px]" />
        ))}
      </div>
    </PageSkeleton>
  );
}

function ListPending({ title }: { title: string }) {
  return (
    <PageSkeleton className="min-h-[calc(100dvh-52px)] pb-4">
      <p className="flex items-center gap-[3px] px-4 pt-3 text-[13px] text-secondary">
        Home
        <IconChevronRight size={13} stroke={1.75} />
        {title}
      </p>
      <Title>{title}</Title>
      <Rows />
    </PageSkeleton>
  );
}

export const SharedPending = () => <ListPending title="Shared with me" />;
export const StarredPending = () => <ListPending title="Starred" />;
export const TrashPending = () => <ListPending title="Trash" />;
export const RecentPending = () => <ListPending title="Recent" />;

// A folder's or a file's name arrives with its contents.
export function FolderPending() {
  return (
    <PageSkeleton className="min-h-[calc(100dvh-52px)] pb-4">
      <div className="px-4 pt-3.5 pb-2.5">
        <Bone className="h-[26px] w-48" />
      </div>
      <Rows />
    </PageSkeleton>
  );
}
