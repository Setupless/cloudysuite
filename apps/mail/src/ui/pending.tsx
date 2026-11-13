import { Bone, PageSkeleton } from "@cloudysuite/ui/skeleton";

// What a page shows while it opens. "App and notifications" and "Import mail" have
// none, because they bring their own sidebar, and a skeleton would replace this one.

function MessageLines({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex gap-2.5 px-2.5 py-2.5">
          <Bone className="size-8 flex-none rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
            <Bone className="h-3 w-2/5" />
            <Bone className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ViewPending() {
  return (
    <PageSkeleton className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col border-line lg:w-[370px] lg:flex-none lg:border-r">
        <div className="flex items-center gap-3 px-4 pt-3.5 pb-2.5">
          <Bone className="h-6 w-24" />
          <Bone className="ml-auto h-9 w-[84px]" />
        </div>
        <MessageLines rows={9} />
      </div>
      <div className="min-w-0 flex-1 bg-panel max-lg:hidden" />
    </PageSkeleton>
  );
}

export function ThreadPending() {
  return (
    <PageSkeleton className="flex flex-col gap-3 px-6 py-5">
      <Bone className="h-5 w-1/2" />
      <Bone className="h-3 w-4/5" />
      <Bone className="h-3 w-3/5" />
    </PageSkeleton>
  );
}

// Labels, Rules, and Blocked and allowed.
export function SettingsPending() {
  return (
    <PageSkeleton className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 lg:p-6">
      <Bone className="h-7 w-32" />
      <div className="flex flex-col gap-3 rounded border border-line p-5">
        <Bone className="h-5 w-40" />
        <Bone className="h-3 w-3/4" />
        <Bone className="h-10" />
      </div>
      <MessageLines rows={3} />
    </PageSkeleton>
  );
}
