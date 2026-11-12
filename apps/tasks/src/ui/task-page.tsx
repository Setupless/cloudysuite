import type { UserId } from "@cloudysuite/access";
import { Button } from "@cloudysuite/ui";
import { IconCheck, IconPlus } from "@tabler/icons-react";
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  use,
  useEffect,
  useState,
} from "react";
import type { PlainDate, TaskId } from "../types";
import { dayOnDevice } from "./dates";
import type { ListAction, ListState } from "./list-state";
import { FOCUS } from "./parts";

const MINUTE_MS = 60_000;

const Me = createContext<UserId | null>(null);

export function MeProvider({
  id,
  children,
}: {
  id: UserId;
  children: ReactNode;
}) {
  return <Me value={id}>{children}</Me>;
}

export function useMe(): UserId {
  const id = use(Me);
  if (!id) throw new Error("useMe() needs a MeProvider above it.");
  return id;
}

// Checked each minute, so a page left open overnight moves its tasks into the new day.
export function useToday(): PlainDate {
  const [today, setToday] = useState(() => dayOnDevice(Date.now()));
  useEffect(() => {
    const timer = setInterval(
      () => setToday(dayOnDevice(Date.now())),
      MINUTE_MS,
    );
    return () => clearInterval(timer);
  }, []);
  return today;
}

const openRowButton = (taskId: TaskId) =>
  document.querySelector<HTMLElement>(
    `[data-task-id="${CSS.escape(taskId)}"] button[aria-expanded]`,
  );

// After the page has drawn the closed panel, back to the row it came from.
export function focusRow(taskId: TaskId) {
  requestAnimationFrame(() => openRowButton(taskId)?.focus());
}

// A dialog over the page, such as New team board, keeps the keys to itself.
const unlessDialog = (run: () => void) => () => {
  if (!document.querySelector(":modal")) run();
};

export function useListKeys(
  state: ListState,
  dispatch: Dispatch<ListAction>,
  canAdd: boolean,
) {
  useHotkey(
    "N",
    unlessDialog(() => {
      if (canAdd) dispatch({ type: "startAdding" });
    }),
  );
  useHotkey(
    "Escape",
    unlessDialog(() => {
      if (state.kind === "open") focusRow(state.taskId);
      dispatch({ type: "close" });
    }),
    // So Esc still closes a dialog, and the date and assignee pickers.
    { preventDefault: false },
  );
}

export function PageHeading({
  title,
  detail,
  swatch,
  canAdd,
  onAdd,
}: {
  title: ReactNode;
  detail?: ReactNode;
  swatch?: ReactNode;
  // Hidden until the page knows what it can offer, so it never appears and then goes.
  canAdd: boolean | null;
  onAdd: () => void;
}) {
  // Narrow, the detail takes its own line under the title, so New task stays beside the
  // title. As in Calendar's Overview, the queries see the screen's width, not the window's.
  return (
    <div className="@container">
      <div className="flex min-h-[62px] flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-3">
        <h1 className="flex min-w-0 grow basis-0 items-center gap-2.5 pl-1 text-[21px] leading-[34px] font-semibold @2xl:grow-0 @2xl:basis-auto">
          {swatch}
          <span className="truncate">{title}</span>
        </h1>
        {detail && (
          <p className="order-1 min-w-0 basis-full pl-1 text-secondary @2xl:order-none @2xl:basis-auto @2xl:pl-0">
            {detail}
          </p>
        )}
        {canAdd && (
          <div className="ml-auto flex-none">
            <Button
              variant="toolbarAction"
              icon={IconPlus}
              aria-keyshortcuts="N"
              onClick={onAdd}
            >
              New task
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const TONES = { plain: "", danger: "text-danger" };

export function TaskSection({
  title,
  tone = "plain",
  count,
  children,
}: {
  title: string;
  tone?: keyof typeof TONES;
  // Left out where it would show how busy a colleague is.
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0">
      <h2
        className={`flex items-baseline gap-2 border-b border-line px-1 pt-4 pb-2 font-semibold ${TONES[tone]}`}
      >
        {title}
        {count !== undefined && (
          <span className="text-[13px] font-normal text-secondary tabular-nums">
            {count}
          </span>
        )}
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

// Done work folds away, like Calendar's events finished earlier, and stays there.
export function DoneFold({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  if (count === 0) return null;
  return (
    <section className="min-w-0 pt-2">
      <p className="flex items-center gap-2 border-b border-line px-1 py-2.5 text-sm text-secondary">
        <IconCheck size={15} stroke={1.75} aria-hidden />
        {label}
        <button
          type="button"
          aria-expanded={shown}
          className={`min-h-6 cursor-pointer rounded text-accent hover:underline ${FOCUS}`}
          onClick={() => setShown(!shown)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </p>
      {shown && <ul>{children}</ul>}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-6 text-sm text-secondary">{children}</p>;
}

export function Loading() {
  return (
    <p className="px-1 py-3 text-sm text-secondary">Loading your tasks…</p>
  );
}
