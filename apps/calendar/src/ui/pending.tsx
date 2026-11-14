import { Bone, type PendingPage } from "@cloudysuite/ui";

// What a page shows while it opens.

function SectionBones({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col">
      <Bone className="mx-1 mt-2 mb-3 h-4 w-28" />
      {Array.from({ length: rows }, (_, index) => (
        <span
          key={index}
          className="flex items-center gap-3 border-t border-line px-1 py-3"
        >
          <Bone className="h-3 w-12" />
          <Bone className={`h-3 ${index % 2 ? "w-1/3" : "w-1/2"}`} />
        </span>
      ))}
    </div>
  );
}

export function OverviewPending() {
  return (
    <div className="pb-6">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2.5">
        <p className="pl-1 text-[21px] leading-[34px] font-semibold">
          Overview
        </p>
        <Bone className="h-4 w-36 max-sm:hidden" />
        <Bone className="ml-auto h-[30px] w-28" />
      </div>
      <div className="flex flex-col gap-5 px-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <Bone className="h-[94px]" />
          <Bone className="h-[94px] max-md:hidden" />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <SectionBones rows={3} />
          <SectionBones rows={2} />
        </div>
        <SectionBones rows={1} />
      </div>
    </div>
  );
}

export function SearchPending() {
  return (
    <div className="min-h-[calc(100dvh-52px)] pb-4">
      <p className="px-4 pt-3.5 pb-2.5 text-[21px] font-semibold">Search</p>
      <div className="flex flex-col gap-3 px-4 pt-3">
        {[0, 1, 2].map((row) => (
          <Bone key={row} className="h-9" />
        ))}
      </div>
    </div>
  );
}

export const CALENDAR_PAGES: readonly PendingPage[] = [
  { to: "/calendar", skeleton: OverviewPending },
  { to: "/calendar/search", skeleton: SearchPending },
];
