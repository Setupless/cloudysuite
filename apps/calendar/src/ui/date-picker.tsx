import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
} from "@tabler/icons-react";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  addMonths,
  contains,
  daysIn,
  monthStartOf,
  type SchedulePlace,
  visibleDays,
  weekStartOf,
} from "../schedule";
import { addDays } from "../time";
import type { CivilDate } from "../types";
import { dayNumber, dayTitle, monthTitle, weekdayNarrow } from "./event-text";

const FOCUS =
  "outline-accent focus-visible:outline-2 focus-visible:outline-offset-1";
const ICON_BUTTON = `flex size-7 cursor-pointer items-center justify-center rounded text-secondary hover:bg-field ${FOCUS}`;

const MOVES: Record<string, (date: CivilDate) => CivilDate> = {
  ArrowLeft: (date) => addDays(date, -1),
  ArrowRight: (date) => addDays(date, 1),
  ArrowUp: (date) => addDays(date, -7),
  ArrowDown: (date) => addDays(date, 7),
  PageUp: (date) => addMonths(date, -1),
  PageDown: (date) => addMonths(date, 1),
  Home: (date) => weekStartOf(date),
  End: (date) => addDays(weekStartOf(date), 6),
};

function MonthOfDays({
  place,
  today,
  onChoose,
}: {
  place: SchedulePlace;
  today: CivilDate;
  onChoose: (date: CivilDate) => void;
}) {
  const [focused, setFocused] = useState(place.date);
  const grid = useRef<HTMLDivElement>(null);
  // Arrow keys move focus within the grid. The month buttons change the month and
  // leave focus where it is.
  const focusGrid = useRef(true);
  const month = monthStartOf(focused);
  const first = weekStartOf(month);
  // Always six weeks, so the picker keeps its size from month to month.
  const days = daysIn({ from: first, to: addDays(first, 42) });
  const weeks = Array.from({ length: 6 }, (_, week) =>
    days.slice(week * 7, week * 7 + 7),
  );
  const marked = place.view === "month" ? null : visibleDays(place);

  useEffect(() => {
    if (!focusGrid.current) return;
    grid.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
  }, [focused]);

  const move = (key: KeyboardEvent) => {
    const step = MOVES[key.key];
    if (!step) return;
    key.preventDefault();
    key.stopPropagation();
    focusGrid.current = true;
    setFocused(step(focused));
  };
  const changeMonth = (by: 1 | -1) => {
    focusGrid.current = false;
    setFocused(addMonths(focused, by));
  };

  return (
    <>
      <div className="flex items-center gap-1 px-1 pb-1 text-[13px] font-semibold">
        <span className="flex-1" aria-live="polite">
          {monthTitle(month)}
        </span>
        <button
          type="button"
          aria-label="Previous month"
          className={ICON_BUTTON}
          onClick={() => changeMonth(-1)}
        >
          <IconChevronLeft size={16} stroke={1.75} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Next month"
          className={ICON_BUTTON}
          onClick={() => changeMonth(1)}
        >
          <IconChevronRight size={16} stroke={1.75} aria-hidden />
        </button>
      </div>
      <div
        ref={grid}
        role="grid"
        aria-label={monthTitle(month)}
        className="flex flex-col gap-px text-center text-xs"
        onKeyDown={move}
      >
        <div role="row" className="grid grid-cols-7">
          {weeks[0]?.map((day) => (
            <span
              key={day}
              role="columnheader"
              className="pb-0.5 text-[11px] font-semibold text-secondary"
            >
              {weekdayNarrow(day)}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} role="row" className="grid grid-cols-7">
            {week.map((day) => {
              const inMonth = day.startsWith(month.slice(0, 7));
              const selected = marked ? contains(marked, day) : false;
              const isToday = day === today;
              return (
                <button
                  key={day}
                  type="button"
                  role="gridcell"
                  tabIndex={day === focused ? 0 : -1}
                  aria-selected={selected}
                  aria-current={isToday ? "date" : undefined}
                  aria-label={dayTitle(day, today)}
                  className={`h-8 cursor-pointer ${FOCUS} ${!selected ? "rounded-full hover:bg-field" : place.view === "day" ? "rounded-full bg-selected" : "bg-selected first:rounded-l-full last:rounded-r-full"}`}
                  onClick={() => onChoose(day)}
                >
                  <span
                    className={`mx-auto flex size-7 items-center justify-center rounded-full ${isToday ? "bg-accent font-semibold text-on-accent" : inMonth ? "text-text" : "text-secondary"}`}
                  >
                    {dayNumber(day)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}

// A day chosen in Week shows that day's week, so the picker keeps the view.
export function TitlePicker({
  title,
  place,
  today,
  open,
  button,
  onToggle,
  onClose,
  onChoose,
}: {
  title: string;
  place: SchedulePlace;
  today: CivilDate;
  open: boolean;
  button: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onClose: () => void;
  onChoose: (date: CivilDate) => void;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (press: PointerEvent) => {
      if (!wrapper.current?.contains(press.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, onClose]);

  return (
    <div ref={wrapper} className="relative min-w-0">
      <h1 className="min-w-0">
        <button
          ref={button}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-[21px] font-semibold hover:bg-field ${open ? "bg-field" : ""} ${FOCUS}`}
          onClick={onToggle}
        >
          <span className="truncate">{title}</span>
          <IconChevronDown
            size={16}
            stroke={1.75}
            className="flex-none text-secondary"
            aria-hidden
          />
        </button>
      </h1>
      {open && (
        <div
          role="dialog"
          aria-label="Choose a date"
          className="absolute top-full left-0 z-30 mt-1 w-[260px] rounded border border-line bg-panel p-2 text-text shadow-lg"
        >
          <MonthOfDays place={place} today={today} onChoose={onChoose} />
        </div>
      )}
    </div>
  );
}
