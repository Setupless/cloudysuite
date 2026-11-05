import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { isWeekend, type OccurrenceKey } from "../schedule";
import { wallOf, wallOfDate } from "../time";
import type { CivilDate, TimeZone } from "../types";
import { calendarBorder, calendarFill, calendarTint } from "./colours";
import {
  dayTitle,
  dayNumber,
  hourText,
  timeText,
  weekdayShort,
} from "./event-text";
import {
  type Bar,
  type Block,
  layoutTimeGrid,
  SHORTEST_MINUTES,
} from "./schedule-layout";
import { type ShownEvent, spokenLabel } from "./shown-event";

const HOUR_PX = 48;
const FIRST_HOUR = 8;
const PX_PER_MINUTE = HOUR_PX / 60;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const FOCUS =
  "outline-accent focus-visible:outline-2 focus-visible:outline-offset-1";

// Written out in full, because Tailwind only makes the classes it finds in the source.
const COLUMNS = {
  1: "grid-cols-[3.5rem_minmax(0,1fr)]",
  7: "grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]",
};

export type EventHandlers = {
  zone: TimeZone;
  today: CivilDate;
  openKey: OccurrenceKey | null;
  opensCard: boolean;
  onOpen: (event: ShownEvent, anchor: HTMLElement) => void;
  onOpenDay: (date: CivilDate) => void;
  // A click on an empty part of a day, in minutes after its midnight.
  onSlot: (date: CivilDate, minute: number) => void;
};

// An invitation not yet answered is dashed, like an outline still to fill in. One the
// person said No to, or that was called off, is struck through.
function eventColours(event: ShownEvent, open: boolean, tinted: boolean) {
  const { colour } = event.calendar;
  const off = event.cancelled || event.answer === "no" ? "line-through" : "";
  if (open) return `${calendarFill(colour)} text-on-avatar ${off}`;
  if (event.answer === "needsAnswer" && !event.cancelled) {
    return `border border-dashed ${calendarBorder(colour)} bg-page text-text hover:bg-field`;
  }
  return tinted
    ? `${calendarTint(colour)} text-text ${off}`
    : `text-text hover:bg-field ${off}`;
}

export function EventButton({
  event,
  handlers: { zone, today, openKey, opensCard, onOpen },
  tinted = true,
  className,
  style,
  children,
}: {
  event: ShownEvent;
  handlers: EventHandlers;
  tinted?: boolean;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const open = event.key === openKey;
  return (
    <button
      type="button"
      aria-label={spokenLabel(event, zone, today)}
      aria-haspopup={opensCard ? "dialog" : undefined}
      aria-expanded={open}
      data-event-key={event.key}
      style={style}
      className={`cursor-pointer text-left ${FOCUS} ${eventColours(event, open, tinted)} ${className}`}
      onClick={(click) => onOpen(event, click.currentTarget)}
    >
      {children}
    </button>
  );
}

function DayHeading({
  day,
  today,
  linked,
  onOpenDay,
}: {
  day: CivilDate;
  today: CivilDate;
  linked: boolean;
  onOpenDay: (date: CivilDate) => void;
}) {
  const isToday = day === today;
  const content = (
    <>
      <span>{weekdayShort(day)}</span>
      <span
        className={`flex size-[30px] items-center justify-center rounded-full text-[19px] font-semibold ${isToday ? "bg-accent text-on-accent" : "text-text"}`}
      >
        {dayNumber(day)}
      </span>
    </>
  );
  const look = `flex items-center gap-1.5 px-1.5 pt-1 pb-1.5 text-xs ${isToday ? "font-semibold text-accent" : "text-secondary"}`;
  return linked ? (
    <button
      type="button"
      aria-label={`Open ${dayTitle(day, today)}`}
      className={`${look} cursor-pointer rounded hover:bg-field ${FOCUS}`}
      onClick={() => onOpenDay(day)}
    >
      {content}
    </button>
  ) : (
    <div className={look} aria-current={isToday ? "date" : undefined}>
      {content}
    </div>
  );
}

function AllDayRow({
  bars,
  rows,
  columns,
  handlers,
}: {
  bars: Bar<ShownEvent>[];
  rows: number;
  columns: string;
  handlers: EventHandlers;
}) {
  return (
    <div
      className={`grid max-h-[6.75rem] min-h-7 auto-rows-[1.5rem] gap-y-0.5 overflow-y-auto border-b border-line py-0.5 ${columns}`}
    >
      <span
        className="col-start-1 self-center pr-2 text-right text-[11px] text-secondary"
        style={{ gridRow: `1 / ${Math.max(rows, 1) + 1}` }}
      >
        All day
      </span>
      {bars.map((bar) => (
        <EventButton
          key={bar.item.key}
          event={bar.item}
          handlers={handlers}
          className={`mx-0.5 truncate px-1.5 text-xs leading-6 font-semibold ${bar.before ? "rounded-l-none" : "rounded-l-md"} ${bar.after ? "rounded-r-none" : "rounded-r-md"}`}
          style={{
            gridColumn: `${bar.first + 2} / ${bar.last + 3}`,
            gridRow: bar.row + 1,
          }}
        >
          {bar.item.title}
        </EventButton>
      ))}
    </div>
  );
}

function TimedBlock({
  block,
  handlers,
}: {
  block: Block<ShownEvent>;
  handlers: EventHandlers;
}) {
  const { item: event, startMinute, endMinute, lane, lanes } = block;
  const minutes = endMinute - startMinute;
  const height = Math.max(minutes, SHORTEST_MINUTES) * PX_PER_MINUTE - 2;
  const short = minutes < 45;
  const time = event.time.kind === "timed" ? event.time : null;
  return (
    <EventButton
      event={event}
      handlers={handlers}
      className={`absolute overflow-hidden rounded-md border-l-3 px-1.5 py-0.5 text-xs leading-tight ${calendarBorder(event.calendar.colour)} ${lane > 0 ? "ring-[1.5px] ring-page" : ""}`}
      style={{
        top: startMinute * PX_PER_MINUTE + 1,
        height: Math.max(height, 24),
        left: `calc(${lane} * 100% / ${lanes} + 2px)`,
        width: `calc(100% / ${lanes} - 5px)`,
      }}
    >
      <span
        className={`block font-semibold ${short ? "line-clamp-1" : "line-clamp-2"}`}
      >
        {event.title}
      </span>
      {time && minutes >= 60 && (
        <span
          className={`block truncate text-[11px] ${event.key === handlers.openKey ? "" : "text-secondary"}`}
        >
          {timeText(time.start)}
          {event.location && `, ${event.location}`}
        </span>
      )}
    </EventButton>
  );
}

function NowLine({
  now,
  zone,
  day,
}: {
  now: number;
  zone: TimeZone;
  day: CivilDate;
}) {
  const minutes = (wallOf(now, zone) - wallOfDate(day)) / 60_000;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-0 -left-px z-[5] h-0.5 bg-accent before:absolute before:-top-1 before:-left-[5px] before:size-2.5 before:rounded-full before:bg-accent"
      style={{ top: minutes * PX_PER_MINUTE - 1 }}
    />
  );
}

export function TimeGrid({
  days,
  events,
  now,
  handlers,
}: {
  days: CivilDate[];
  events: ShownEvent[];
  now: number;
  handlers: EventHandlers;
}) {
  const { zone, today } = handlers;
  const layout = useMemo(
    () => layoutTimeGrid(days, events, zone),
    [days, events, zone],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const columns = COLUMNS[days.length as 1 | 7];

  // Opens at 8:00, or a little before now when today is on screen and now would be out
  // of sight. Moving to another day or week keeps where the person scrolled to.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const header = (element.firstElementChild as HTMLElement).offsetHeight;
    const shownHours = (element.clientHeight - header) / HOUR_PX;
    const nowHour = (wallOf(now, zone) - wallOfDate(today)) / 3_600_000;
    const nowInSight =
      nowHour >= FIRST_HOUR && nowHour <= FIRST_HOUR + shownHours - 1;
    const hour =
      days.includes(today) && !nowInSight
        ? Math.max(0, nowHour - 2)
        : FIRST_HOUR;
    element.scrollTop = hour * HOUR_PX - 8;
  }, []);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <div className={`sticky top-0 z-10 grid bg-page ${columns}`}>
        <div className="border-b border-line" />
        {days.map((day) => (
          <div key={day} className="border-b border-line">
            <DayHeading
              day={day}
              today={today}
              linked={days.length > 1}
              onOpenDay={handlers.onOpenDay}
            />
          </div>
        ))}
        <div className="col-span-full">
          <AllDayRow
            bars={layout.bars}
            rows={layout.barRows}
            columns={columns}
            handlers={handlers}
          />
        </div>
      </div>
      <div className={`grid ${columns}`}>
        <div aria-hidden>
          {HOURS.map((hour) => (
            <div
              key={hour}
              className="h-12 -translate-y-[7px] pr-2 text-right text-[11px] text-secondary first:invisible"
            >
              {hourText(hour)}
            </div>
          ))}
        </div>
        {days.map((day, index) => (
          <div
            key={day}
            role="group"
            aria-label={dayTitle(day, today)}
            data-column
            onClick={(click) => {
              if (click.target === click.currentTarget) {
                handlers.onSlot(day, click.nativeEvent.offsetY / PX_PER_MINUTE);
              }
            }}
            className={`relative h-[1152px] border-l border-line bg-[repeating-linear-gradient(to_bottom,transparent_0_47px,var(--color-line)_47px_48px)] ${isWeekend(day) ? "bg-weekend" : ""}`}
          >
            {layout.columns[index]?.map((block) => (
              <TimedBlock
                key={block.item.key}
                block={block}
                handlers={handlers}
              />
            ))}
            {day === today && <NowLine now={now} zone={zone} day={day} />}
          </div>
        ))}
      </div>
    </div>
  );
}
