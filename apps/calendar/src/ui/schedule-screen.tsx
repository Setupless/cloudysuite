import { Button, Notice, useHydrated } from "@cloudysuite/ui";
import {
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
} from "@tabler/icons-react";
import { PrefetchedData } from "@cloudysuite/page-data";
import { type DehydratedState, useQuery } from "@tanstack/react-query";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calendarsQuery, eventsQuery } from "../queries";
import {
  daysIn,
  type OccurrenceKey,
  placeOf,
  SCHEDULE_VIEWS,
  type ScheduleSearch,
  type ScheduleView,
  searchOf,
  steppedDate,
  todayIn,
  visibleDays,
} from "../schedule";
import { deviceZone } from "../time";
import type { CivilDate, EventUid } from "../types";
import { TitlePicker } from "./date-picker";
import { EventCard, EventPanel } from "./event-details";
import { DeleteEventDialog, EventDialog, type Opening } from "./event-dialog";
import {
  type EventAction,
  type FormStart,
  nextHalfHour,
  slotStart,
} from "./event-form";
import { dayTitle, monthTitle, shortDayTitle, weekTitle } from "./event-text";
import { MonthGrid } from "./month-grid";
import {
  listedTasks,
  shownTasks,
  TASKS_FAILED,
  unreachableBoards,
  unreachableText,
  useDueTasks,
} from "./my-tasks";
import { daySpanOf } from "./schedule-layout";
import { type ShownEvent, shownEvents } from "./shown-event";
import { type EventHandlers, TimeGrid } from "./time-grid";

// The toolbar and grids change at the width of this screen, not the window, because the
// sidebar takes room from it on a tablet.
const SCREEN = "@container flex h-[calc(100dvh-52px)] flex-col";
// Narrow, it's two lines: the buttons that move, then the title and the views. That
// split is the same in every view, so switching views never moves the grid.
const TOOLBAR =
  "flex flex-none flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-2.5";
const NARROW_SECOND_LINE = "order-1 @3xl:order-none";
const LINE_BREAK = `h-1 basis-full @3xl:hidden ${NARROW_SECOND_LINE}`;
const FOCUS =
  "outline-accent focus-visible:outline-2 focus-visible:outline-offset-1";
const VIEW_NAMES: Record<ScheduleView, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

// Back and Forward change the place without closing anything, so a card belongs to the
// place it opened in.
type OpenCard = { key: OccurrenceKey; anchor: HTMLElement; at: string };

// `back` is where focus goes if the person closes it without saving.
type OpenDialog = (Opening | (EventAction & { event: ShownEvent })) & {
  back: HTMLElement | null;
};

const eventWithKey = (key: string) =>
  document.querySelector<HTMLElement>(`[data-event-key="${CSS.escape(key)}"]`);

// A key ends with the event's UID.
const eventWithUid = (uid: EventUid) =>
  document.querySelector<HTMLElement>(
    `[data-event-key$="/${CSS.escape(uid)}"]`,
  );

// After the page has drawn what changed, to the first of these still on it.
export function focusFirst(
  ...candidates: (() => HTMLElement | null | undefined)[]
) {
  requestAnimationFrame(() => {
    for (const candidate of candidates) {
      const element = candidate();
      if (element?.isConnected) return element.focus();
    }
  });
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// A dialog over the page, such as New team calendar, keeps the keys to itself.
export const unlessDialog = (run: () => void) => () => {
  if (!document.querySelector(":modal")) run();
};
// So Esc can still close that dialog, and the arrows can still move between its choices.
const KEEP_DEFAULT = { preventDefault: false };
// Null when nothing has focus, so closing a dialog that a key opened falls back to New event.
export const focusedElement = () =>
  document.activeElement instanceof HTMLElement &&
  document.activeElement !== document.body
    ? document.activeElement
    : null;

function LiveSchedule({ search }: { search: ScheduleSearch }) {
  const [zone] = useState(deviceZone);
  const now = useNow();
  const today = todayIn(zone, now);
  const place = placeOf(search, today);
  const window = useMemo(
    () => visibleDays({ view: place.view, date: place.date }),
    [place.view, place.date],
  );
  const days = useMemo(() => daysIn(window), [window]);
  const navigate = useNavigate({ from: "/calendar/schedule" });
  const calendars = useQuery(calendarsQuery());
  const listing = useQuery(eventsQuery(window));
  const events = useMemo(
    () => shownEvents(listing.data, calendars.data),
    [listing.data, calendars.data],
  );
  const { tasksHref, due } = useDueTasks(window.from, window.to);
  // A disabled query keeps its last answer, so once Tasks is off, ignore it.
  const dueData = tasksHref === undefined ? undefined : due.data;
  const tasks = useMemo(() => shownTasks(listedTasks(dueData)), [dueData]);
  const unreachable = unreachableBoards(dueData);
  const at = `${place.view}/${place.date}`;
  const [openCard, setCard] = useState<OpenCard | null>(null);
  const card = openCard?.at === at ? openCard : null;
  const [picking, setPicking] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);

  const go = (
    view: ScheduleView,
    date: CivilDate | undefined,
    event?: OccurrenceKey,
  ) => {
    setCard(null);
    setPicking(false);
    void navigate({ search: searchOf(view, date, event) });
  };
  const showPanel = (event: OccurrenceKey | undefined) =>
    void navigate({
      search: searchOf("day", search.date, event),
      replace: true,
      resetScroll: false,
    });
  const closePanel = () => {
    const key = search.event;
    showPanel(undefined);
    if (key) focusFirst(() => eventWithKey(key));
  };
  const closeCard = useCallback(
    (refocus: boolean) => {
      if (refocus) card?.anchor.focus();
      setCard(null);
    },
    [card],
  );
  const closePicker = useCallback(() => setPicking(false), []);

  const openDialog = (opened: OpenDialog) => {
    setCard(null);
    setPicking(false);
    setDialog(opened);
  };
  // Nothing opens before the calendars load, or the dialog would appear later with no warning.
  const openNew = (start: FormStart, back: HTMLElement | null) => {
    if (calendars.data) openDialog({ kind: "new", start, back });
  };
  const closeDialog = () => {
    const back = dialog?.back;
    setDialog(null);
    focusFirst(
      () => back,
      () => newButton.current,
    );
  };
  const afterChange = (saved: EventUid | null) => {
    const changed = dialog?.kind === "new" ? null : dialog?.event.key;
    setDialog(null);
    setCard(null);
    if (place.view === "day" && search.event) showPanel(undefined);
    focusFirst(
      () => changed && eventWithKey(changed),
      () => saved && eventWithUid(saved),
      () => newButton.current,
    );
  };

  const closeTop = () => {
    if (picking) {
      setPicking(false);
      titleButton.current?.focus();
    } else if (card) {
      closeCard(true);
    } else if (place.view === "day" && search.event) {
      closePanel();
    }
  };

  useHotkey(
    "T",
    unlessDialog(() => go(place.view, undefined)),
  );
  useHotkey(
    "D",
    unlessDialog(() => go("day", search.date)),
  );
  useHotkey(
    "W",
    unlessDialog(() => go("week", search.date)),
  );
  useHotkey(
    "M",
    unlessDialog(() => go("month", search.date)),
  );
  useHotkey(
    "ArrowLeft",
    unlessDialog(() => go(place.view, steppedDate(place, -1))),
    KEEP_DEFAULT,
  );
  useHotkey(
    "ArrowRight",
    unlessDialog(() => go(place.view, steppedDate(place, 1))),
    KEEP_DEFAULT,
  );
  useHotkey("Escape", unlessDialog(closeTop), KEEP_DEFAULT);
  useHotkey(
    "N",
    unlessDialog(() =>
      openNew(nextHalfHour(Date.now(), zone), focusedElement()),
    ),
  );

  const inDay = place.view === "day";
  const handlers: EventHandlers = {
    zone,
    today,
    openKey: inDay ? (search.event ?? null) : (card?.key ?? null),
    opensCard: !inDay,
    onOpen: (event, anchor) => {
      setPicking(false);
      if (inDay) {
        showPanel(event.key === search.event ? undefined : event.key);
      } else {
        setCard(
          card?.key === event.key ? null : { key: event.key, anchor, at },
        );
      }
    },
    onOpenDay: (date) => go("day", date),
    onSlot: (date, minute) => openNew(slotStart(date, minute), null),
  };
  const cardEvent =
    card && !inDay ? events.find((event) => event.key === card.key) : undefined;
  const failure = calendars.error ?? listing.error;
  const panelEvent = inDay
    ? events.find((event) => event.key === search.event)
    : undefined;

  const [title, shortTitle] =
    place.view === "day"
      ? [dayTitle(place.date, today), shortDayTitle(place.date, today)]
      : place.view === "week"
        ? [weekTitle(window, today), weekTitle(window, today, "short")]
        : [monthTitle(place.date), monthTitle(place.date, "short")];

  return (
    <div className={SCREEN}>
      <div className={TOOLBAR}>
        <Button variant="toolbar" onClick={() => go(place.view, undefined)}>
          Go to today
        </Button>
        <Button
          variant="toolbar"
          icon={IconChevronLeft}
          aria-label={`Previous ${place.view}`}
          onClick={() => go(place.view, steppedDate(place, -1))}
        />
        <Button
          variant="toolbar"
          icon={IconChevronRight}
          aria-label={`Next ${place.view}`}
          onClick={() => go(place.view, steppedDate(place, 1))}
        />
        <div aria-hidden className={LINE_BREAK} />
        <TitlePicker
          title={title}
          shortTitle={shortTitle}
          className={`flex-1 basis-0 ${NARROW_SECOND_LINE}`}
          place={place}
          today={today}
          open={picking}
          button={titleButton}
          onToggle={() => {
            setCard(null);
            setPicking(!picking);
          }}
          onClose={closePicker}
          onChoose={(date) => {
            go(place.view, date);
            titleButton.current?.focus();
          }}
        />
        <div
          role="group"
          aria-label="View"
          className={`flex flex-none rounded bg-field p-0.5 ${NARROW_SECOND_LINE}`}
        >
          {SCHEDULE_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={view === place.view}
              className={`min-h-6 cursor-pointer rounded-[7px] px-2 py-1 @lg:px-[11px] text-[13px] ${FOCUS} ${view === place.view ? "bg-page font-semibold text-text shadow-sm" : "text-secondary hover:text-text"}`}
              onClick={() => go(view, search.date)}
            >
              {VIEW_NAMES[view]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex h-[34px] flex-none items-center">
          <Button
            ref={newButton}
            variant="toolbarAction"
            icon={IconPlus}
            aria-keyshortcuts="N"
            disabled={!calendars.data}
            onClick={(click) =>
              openNew(nextHalfHour(Date.now(), zone), click.currentTarget)
            }
          >
            {/* Only the + on the smallest phones, so the first line still fits. */}
            <span className="@max-[22rem]:sr-only">New event</span>
          </Button>
        </div>
      </div>
      {failure && (
        <div className="px-4 pb-2">
          <Notice tone="danger">{failure.message}</Notice>
        </div>
      )}
      {listing.data && !listing.data.complete && (
        <div className="px-4 pb-2">
          <Notice tone="info">
            {inDay
              ? "There are too many events here to show them all."
              : "There are too many events here to show them all. Switch to a shorter view to see the rest."}
          </Notice>
        </div>
      )}
      {tasksHref !== undefined && due.error && (
        <div className="px-4 pb-2">
          <Notice tone="info">{TASKS_FAILED}</Notice>
        </div>
      )}
      {unreachable > 0 && (
        <div className="px-4 pb-2">
          <Notice tone="info">{unreachableText(unreachable)}</Notice>
        </div>
      )}
      <div
        className="relative flex min-h-0 flex-1 border-t border-line"
        aria-busy={listing.isPending || calendars.isPending || undefined}
      >
        {place.view === "month" ? (
          <MonthGrid
            date={place.date}
            window={window}
            events={events}
            tasks={tasks}
            handlers={handlers}
          />
        ) : (
          <TimeGrid
            days={days}
            events={events}
            tasks={tasks}
            now={now}
            handlers={handlers}
          />
        )}
        {panelEvent && (
          <EventPanel
            key={panelEvent.key}
            event={panelEvent}
            zone={zone}
            today={today}
            onClose={closePanel}
            calendars={calendars.data ?? []}
            onAction={(action, button) =>
              openDialog({ ...action, event: panelEvent, back: button })
            }
          />
        )}
        {cardEvent && card && (
          <EventCard
            key={cardEvent.key}
            event={cardEvent}
            anchor={card.anchor}
            zone={zone}
            today={today}
            onClose={closeCard}
            onOpenDetails={() =>
              go("day", daySpanOf(cardEvent.time, zone).first, cardEvent.key)
            }
            calendars={calendars.data ?? []}
            onAction={(action) =>
              openDialog({ ...action, event: cardEvent, back: card.anchor })
            }
          />
        )}
      </div>
      {dialog?.kind === "delete" || dialog?.kind === "remove" ? (
        <DeleteEventDialog
          event={dialog.event}
          action={dialog}
          onDone={() => afterChange(null)}
          onClose={closeDialog}
        />
      ) : (
        dialog &&
        calendars.data && (
          <EventDialog
            opening={dialog}
            calendars={calendars.data}
            zone={zone}
            onSaved={afterChange}
            onClose={closeDialog}
          />
        )
      )}
    </div>
  );
}

function Schedule({ search }: { search: ScheduleSearch }) {
  // The server knows neither the reader's time zone nor their language, so the days
  // wait for the browser. The events are already here by then.
  const hydrated = useHydrated();
  return hydrated ? (
    <LiveSchedule search={search} />
  ) : (
    <div className={SCREEN}>
      {/* The same lines as the toolbar, so the grid doesn't move when it arrives. */}
      <div className={TOOLBAR}>
        <div className="h-[34px]" />
        <div className={LINE_BREAK} />
        <div className={`h-[34px] @3xl:hidden ${NARROW_SECOND_LINE}`} />
      </div>
    </div>
  );
}

export function ScheduleScreen({
  search,
  prefetched,
}: {
  search: ScheduleSearch;
  prefetched: DehydratedState | undefined;
}) {
  return (
    <PrefetchedData state={prefetched}>
      <Schedule search={search} />
    </PrefetchedData>
  );
}
