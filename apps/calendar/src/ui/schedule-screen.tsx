import { Button, Notice, useHydrated } from "@cloudysuite/ui";
import {
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
} from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
} from "@tanstack/react-query";
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
import { parseTimeZone } from "../time";
import type { CivilDate, EventUid, TimeZone } from "../types";
import { TitlePicker } from "./date-picker";
import { EventCard, EventPanel } from "./event-details";
import { DeleteEventDialog, EventDialog, type Opening } from "./event-dialog";
import { type FormStart, nextHalfHour, slotStart } from "./event-form";
import { dayTitle, monthTitle, weekTitle } from "./event-text";
import { MonthGrid } from "./month-grid";
import { daySpanOf } from "./schedule-layout";
import { type ShownEvent, shownEvents } from "./shown-event";
import { type EventHandlers, TimeGrid } from "./time-grid";

const SCREEN = "flex h-[calc(100dvh-52px)] flex-col";
const TOOLBAR = "flex flex-none flex-wrap items-center gap-2 px-4 pt-3 pb-2.5";
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
type OpenDialog = (Opening | { kind: "delete"; event: ShownEvent }) & {
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
function focusFirst(...candidates: (() => HTMLElement | null | undefined)[]) {
  requestAnimationFrame(() => {
    for (const candidate of candidates) {
      const element = candidate();
      if (element?.isConnected) return element.focus();
    }
  });
}

export const deviceZone = () =>
  parseTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
  ("UTC" as TimeZone);

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// A dialog over the page, such as New team calendar, keeps the keys to itself.
const unlessDialog = (run: () => void) => () => {
  if (!document.querySelector(":modal")) run();
};
// So Esc can still close that dialog, and the arrows can still move between its choices.
const KEEP_DEFAULT = { preventDefault: false };

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
  const openNew = (start: FormStart, back: HTMLElement | null) =>
    openDialog({ kind: "new", start, back });
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
      openNew(
        nextHalfHour(Date.now(), zone),
        document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body
          ? document.activeElement
          : null,
      ),
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

  const title =
    place.view === "day"
      ? dayTitle(place.date, today)
      : place.view === "week"
        ? weekTitle(window, today)
        : monthTitle(place.date);

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
        <TitlePicker
          title={title}
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
          className="ml-auto flex rounded bg-field p-0.5"
        >
          {SCHEDULE_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={view === place.view}
              className={`min-h-6 cursor-pointer rounded-[7px] px-[11px] py-1 text-[13px] ${FOCUS} ${view === place.view ? "bg-page font-semibold text-text shadow-sm" : "text-secondary hover:text-text"}`}
              onClick={() => go(view, search.date)}
            >
              {VIEW_NAMES[view]}
            </button>
          ))}
        </div>
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
          New event
        </Button>
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
      <div
        className="relative flex min-h-0 flex-1 border-t border-line"
        aria-busy={listing.isPending || calendars.isPending || undefined}
      >
        {place.view === "month" ? (
          <MonthGrid
            date={place.date}
            window={window}
            events={events}
            handlers={handlers}
          />
        ) : (
          <TimeGrid days={days} events={events} now={now} handlers={handlers} />
        )}
        {panelEvent && (
          <EventPanel
            key={panelEvent.key}
            event={panelEvent}
            zone={zone}
            today={today}
            onClose={closePanel}
            onEdit={(button) =>
              openDialog({ kind: "edit", event: panelEvent, back: button })
            }
            onDelete={(button) =>
              openDialog({ kind: "delete", event: panelEvent, back: button })
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
            onEdit={() =>
              openDialog({ kind: "edit", event: cardEvent, back: card.anchor })
            }
            onDelete={() =>
              openDialog({
                kind: "delete",
                event: cardEvent,
                back: card.anchor,
              })
            }
          />
        )}
      </div>
      {dialog?.kind === "delete" ? (
        <DeleteEventDialog
          event={dialog.event}
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
      <div className={TOOLBAR}>
        <div className="h-[34px]" />
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
    <HydrationBoundary state={prefetched}>
      <Schedule search={search} />
    </HydrationBoundary>
  );
}
