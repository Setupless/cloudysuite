import { Bone, type PendingPage } from "@cloudysuite/ui";

// What a page shows while it opens: its heading, then rows of tasks.

const TITLE_WIDTHS = ["w-2/5", "w-1/2", "w-1/3", "w-2/5"];

function Heading({ title }: { title: string | null }) {
  return (
    <div className="flex min-h-[62px] items-center gap-x-3 px-4 pt-3 pb-3">
      {title === null ? (
        <Bone className="ml-1 h-6 w-40" />
      ) : (
        <p className="pl-1 text-[21px] leading-[34px] font-semibold">{title}</p>
      )}
      <Bone className="h-4 w-36 max-sm:hidden" />
      <Bone className="ml-auto h-[30px] w-[104px]" />
    </div>
  );
}

function TaskList({ title }: { title: string | null }) {
  return (
    <div className="min-h-[calc(100dvh-3.25rem)] *:max-w-[912px]">
      <Heading title={title} />
      <div className="px-4">
        <Bone className="mx-1 mt-4 mb-2 h-4 w-24" />
        {TITLE_WIDTHS.map((width, index) => (
          <span
            key={index}
            className="flex min-h-11 items-center gap-3 border-t border-line pl-2.5"
          >
            <Bone className="size-[18px] flex-none rounded-full" />
            <Bone className={`h-3 ${width}`} />
          </span>
        ))}
      </div>
    </div>
  );
}

export const MyTasksPending = () => <TaskList title="My tasks" />;
// A board's or a person's name arrives with their tasks.
export const BoardPending = () => <TaskList title={null} />;

export function SearchPending() {
  return (
    <div className="min-h-[calc(100dvh-3.25rem)] pb-6 *:max-w-[912px]">
      <div className="flex min-h-[62px] items-center px-4 pt-3 pb-3">
        <p className="pl-1 text-[21px] leading-[34px] font-semibold">Search</p>
      </div>
      <div className="flex flex-col gap-3 px-4 pt-3">
        {[0, 1, 2].map((row) => (
          <Bone key={row} className="h-9" />
        ))}
      </div>
    </div>
  );
}

export const TASKS_PAGES: readonly PendingPage[] = [
  { to: "/tasks", skeleton: MyTasksPending },
  { to: "/tasks/boards/$boardId", skeleton: BoardPending },
  { to: "/tasks/people/$userId", skeleton: BoardPending },
  { to: "/tasks/search", skeleton: SearchPending },
];
