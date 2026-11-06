import { useMemo } from "react";
import { type DayWindow, daysIn, monthStartOf } from "../schedule";
import type { CivilDate } from "../types";
import { calendarFill } from "./colours";
import {
  dayAndMonth,
  dayNumber,
  dayTitle,
  timeText,
  weekdayShort,
} from "./event-text";
import { layoutMonthWeek, type MonthEntry } from "./schedule-layout";
import type { ShownEvent } from "./shown-event";
import { EventButton, type EventHandlers } from "./time-grid";

const FOCUS =
  "outline-accent focus-visible:outline-2 focus-visible:outline-offset-1";

// A line for the day number, three lines of events, a line for "N more", then the
// rest of the cell.
const WEEK_ROWS = "grid-rows-[1.75rem_repeat(3,1.5rem)_1.5rem_minmax(0,1fr)]";

function Entry({
  entry,
  handlers,
}: {
  entry: MonthEntry<ShownEvent>;
  handlers: EventHandlers;
}) {
  const { item: event } = entry;
  const placement = {
    gridColumn: `${entry.first + 1} / ${entry.last + 2}`,
    gridRow: entry.row + 2,
  };
  if (entry.kind === "bar") {
    return (
      <EventButton
        event={event}
        handlers={handlers}
        style={placement}
        className={`mx-1 truncate px-1.5 text-xs leading-6 font-semibold @max-3xl:mx-0.5 @max-3xl:px-1 ${entry.before ? "rounded-l-none" : "rounded-l"} ${entry.after ? "rounded-r-none" : "rounded-r"}`}
      >
        {event.title}
      </EventButton>
    );
  }
  const open = event.key === handlers.openKey;
  return (
    <EventButton
      event={event}
      handlers={handlers}
      tinted={false}
      style={placement}
      className="mx-1 flex min-w-0 items-center gap-1 rounded px-1 text-xs @max-3xl:mx-0.5 @max-3xl:px-0.5"
    >
      <span
        aria-hidden
        className={`size-[7px] flex-none rounded-full ${calendarFill(event.calendar.colour)} ${open ? "outline outline-on-avatar" : ""}`}
      />
      {/* On a phone a day is too narrow for the time and the title both. */}
      {event.time.kind === "timed" && (
        <span
          className={`flex-none @max-3xl:hidden ${open ? "" : "text-secondary"}`}
        >
          {timeText(event.time.start)}
        </span>
      )}
      <span className="truncate">{event.title}</span>
    </EventButton>
  );
}

function Week({
  days,
  month,
  events,
  handlers,
}: {
  days: CivilDate[];
  month: string;
  events: ShownEvent[];
  handlers: EventHandlers;
}) {
  const { zone, today, onOpenDay } = handlers;
  const { entries, hidden } = useMemo(
    () => layoutMonthWeek(days, events, zone),
    [days, events, zone],
  );
  return (
    <div
      className={`grid min-h-31 flex-1 basis-0 grid-cols-7 ${WEEK_ROWS} border-b border-line`}
    >
      {days.map((day, index) => {
        const inMonth = day.startsWith(month);
        const isToday = day === today;
        return (
          <div
            key={day}
            className="border-r border-line"
            style={{ gridColumn: index + 1, gridRow: "1 / -1" }}
          >
            <button
              type="button"
              aria-label={`Open ${dayTitle(day, today)}`}
              aria-current={isToday ? "date" : undefined}
              className={`mt-1 ml-1 flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-full px-1.5 text-xs font-semibold whitespace-nowrap ${FOCUS} ${isToday ? "bg-accent text-on-accent" : `hover:bg-field ${inMonth ? "text-text" : "text-secondary"}`}`}
              onClick={() => onOpenDay(day)}
            >
              {day.endsWith("-01") && !inMonth ? (
                <>
                  {/* On a phone a day is too narrow for its month as well. */}
                  <span className="@max-3xl:hidden">{dayAndMonth(day)}</span>
                  <span className="@3xl:hidden">{dayNumber(day)}</span>
                </>
              ) : (
                dayNumber(day)
              )}
            </button>
          </div>
        );
      })}
      {entries.map((entry) => (
        <Entry key={entry.item.key} entry={entry} handlers={handlers} />
      ))}
      {hidden.map((count, index) =>
        count === 0 ? null : (
          <button
            key={days[index]}
            type="button"
            aria-label={`${count} more on ${dayTitle(days[index] as CivilDate, today)}`}
            className={`mx-1 cursor-pointer truncate rounded px-1 text-left text-xs text-accent hover:bg-field @max-3xl:mx-0.5 @max-3xl:px-0.5 ${FOCUS}`}
            style={{ gridColumn: index + 1, gridRow: 5 }}
            onClick={() => onOpenDay(days[index] as CivilDate)}
          >
            <span className="@max-3xl:hidden">{count} more</span>
            <span className="@3xl:hidden">+{count}</span>
          </button>
        ),
      )}
    </div>
  );
}

export function MonthGrid({
  date,
  window,
  events,
  handlers,
}: {
  date: CivilDate;
  window: DayWindow;
  events: ShownEvent[];
  handlers: EventHandlers;
}) {
  const weeks = useMemo(() => {
    const days = daysIn(window);
    return Array.from({ length: days.length / 7 }, (_, week) =>
      days.slice(week * 7, week * 7 + 7),
    );
  }, [window]);
  const month = monthStartOf(date).slice(0, 7);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-3.5">
      <div className="sticky top-0 z-10 grid flex-none grid-cols-7 bg-page pb-1.5 text-xs font-semibold text-secondary">
        {weeks[0]?.map((day) => (
          <span key={day} className="pl-[7px]">
            {weekdayShort(day)}
          </span>
        ))}
      </div>
      <div className="flex flex-1 flex-col border-t border-l border-line">
        {weeks.map((days) => (
          <Week
            key={days[0]}
            days={days}
            month={month}
            events={events}
            handlers={handlers}
          />
        ))}
      </div>
    </div>
  );
}
