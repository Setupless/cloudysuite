import { Notice, useHydrated } from "@cloudysuite/ui";
import {
  IconCalendar,
  IconCheck,
  IconClock,
  IconMapPin,
  IconUsers,
} from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { calendarsQuery, eventsQuery, invitationsQuery } from "../queries";
import { keyOf, searchOf, todayIn } from "../schedule";
import type { CivilDate, TimeZone } from "../types";
import { calendarBorder, calendarFill, calendarTint } from "./colours";
import { dayNumber, dayTitle, timeText, weekdayShort } from "./event-text";
import { AnswerButtons } from "./invitation-parts";
import { JoinButton, meetingOf } from "./join-button";
import { useMe } from "./me";
import { comingLine, peopleSummary } from "./people-text";
import { daySpanOf } from "./schedule-layout";
import { deviceZone } from "./schedule-screen";
import {
  type ShownEvent,
  shownEvents,
  spokenLabel,
  whenOf,
} from "./shown-event";
import {
  type HoursOnDay,
  type NextEvent,
  hoursOnDay,
  planToday,
  type TodayPlan,
  todayWindow,
  untilText,
  type WeekDay,
} from "./today-plan";

const MINUTE_MS = 60_000;
const MOST_DOTS = 6;
const FOCUS = "outline-accent focus-visible:outline-2";
const SECTION =
  "flex items-baseline gap-2 border-b border-line px-1 pb-2 font-semibold";
const ROW = `grid items-center gap-2.5 border-b border-line px-1 py-2.5 text-sm hover:bg-field ${FOCUS}`;
const SPAN_COLUMNS = "grid-cols-[6.5rem_auto_minmax(0,1fr)]";
const START_COLUMNS = "grid-cols-[4.5rem_auto_minmax(0,1fr)]";

// Ticks on the minute, so "in 25 minutes" and the finished events change together and
// the page draws once a minute.
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS));
    };
    timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS));
    return () => clearTimeout(timer);
  }, []);
  return now;
}

function hoursText(hours: HoursOnDay, startOnly = false): string {
  switch (hours.kind) {
    case "between":
      return startOnly
        ? timeText(hours.start)
        : `${timeText(hours.start)} to ${timeText(hours.end)}`;
    case "from":
      return `From ${timeText(hours.start)}`;
    case "until":
      return `Until ${timeText(hours.end)}`;
    case "allDay":
      return "All day";
  }
}

function EventLink({
  event,
  day,
  className,
  label,
  children,
}: {
  event: ShownEvent;
  day: CivilDate;
  className: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/calendar/schedule"
      search={searchOf("day", day, event.key)}
      aria-label={label}
      className={className}
    >
      {children}
    </Link>
  );
}

function NextCard({
  next,
  plan,
  zone,
  now,
}: {
  next: NextEvent<ShownEvent>;
  plan: TodayPlan<ShownEvent>;
  zone: TimeZone;
  now: number;
}) {
  const me = useMe();
  if (next.kind === "none") {
    return (
      <div className="flex flex-col justify-center rounded border border-line p-3.5 text-secondary">
        Nothing else today or tomorrow.
      </div>
    );
  }
  const { event } = next;
  const day = next.kind === "today" ? plan.today : plan.tomorrow;
  const heading =
    next.kind === "today"
      ? `Next, ${untilText(next.start, now)}`
      : `Nothing else today. Next, tomorrow at ${timeText(next.start)}`;
  const meeting = meetingOf(event);
  const coming = comingLine(event.people, me);
  // The event link covers the whole card, and Join sits above it, because one link
  // can't hold another.
  return (
    <div
      className={`relative flex min-w-0 flex-col gap-2.5 rounded border border-l-4 border-y-line border-r-line p-3.5 hover:bg-field ${calendarBorder(event.calendar.colour)}`}
    >
      <EventLink
        event={event}
        day={day}
        label={[heading, spokenLabel(event, zone, plan.today), coming]
          .filter(Boolean)
          .join(". ")}
        className="flex min-w-0 flex-col gap-2.5 outline-none after:absolute after:-inset-px after:rounded after:outline-accent focus-visible:after:outline-2"
      >
        <span className="text-xs font-semibold text-accent">{heading}</span>
        <span className="text-lg font-semibold break-words">{event.title}</span>
        <span className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] text-secondary">
          <span className="flex items-center gap-1.5">
            <IconClock size={15} stroke={1.75} aria-hidden />
            {hoursText(hoursOnDay(event.time, day, zone))}
          </span>
          {event.location && (
            <span className="flex min-w-0 items-center gap-1.5">
              <IconMapPin
                size={15}
                stroke={1.75}
                className="flex-none"
                aria-hidden
              />
              <span className="truncate">{event.location}</span>
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1.5">
            <IconCalendar
              size={15}
              stroke={1.75}
              className="flex-none"
              aria-hidden
            />
            <span className="truncate">{event.calendar.name}</span>
          </span>
        </span>
        {coming && (
          <span className="flex min-w-0 items-start gap-1.5 text-[13px] text-secondary">
            <IconUsers
              size={15}
              stroke={1.75}
              className="mt-px flex-none"
              aria-hidden
            />
            <span className="min-w-0">{coming}</span>
          </span>
        )}
      </EventLink>
      {meeting && <JoinButton link={meeting} />}
    </div>
  );
}

function InvitationRow({
  event,
  zone,
  today,
}: {
  event: ShownEvent;
  zone: TimeZone;
  today: CivilDate;
}) {
  const { days, hours } = whenOf(event, zone, today);
  const summary = peopleSummary(event, useMe());
  // Schedule leaves a hidden calendar out, so there'd be nothing to open there.
  const opens = !event.calendar.hidden;
  const details = (
    <>
      <span
        className={`truncate font-semibold ${opens ? "hover:underline" : ""}`}
      >
        {event.title}
      </span>
      <span className="text-[13px] text-secondary">
        {hours ? `${days}, ${hours}` : days}
      </span>
      {summary && <span className="text-[13px] text-secondary">{summary}</span>}
    </>
  );
  const shape = "flex min-w-0 flex-1 flex-col gap-0.5 text-sm";
  return (
    <li className="flex flex-col gap-2 border-b border-line px-1 py-2.5 sm:flex-row sm:items-center">
      {opens ? (
        <EventLink
          event={event}
          day={daySpanOf(event.time, zone).first}
          label={`${spokenLabel(event, zone, today)}. ${summary ?? ""}`}
          className={`${shape} rounded ${FOCUS}`}
        >
          {details}
        </EventLink>
      ) : (
        <div className={shape}>{details}</div>
      )}
      <AnswerButtons event={event} />
    </li>
  );
}

// Unanswered copies in the person's own calendar, even when they've hidden it, so an
// invitation can't be missed.
function Invitations({ zone, today }: { zone: TimeZone; today: CivilDate }) {
  const calendars = useQuery(calendarsQuery());
  const invitations = useQuery(invitationsQuery(zone));
  const personal = calendars.data?.[0];
  const events: ShownEvent[] = (invitations.data ?? []).flatMap((occurrence) =>
    personal?.id === occurrence.calendarId
      ? [{ ...occurrence, key: keyOf(occurrence), calendar: personal }]
      : [],
  );
  return (
    <section className="min-w-0">
      <h2 className={SECTION}>
        Invitations
        {events.length > 0 && (
          <span className="text-[13px] font-normal text-secondary">
            {events.length} waiting for an answer
          </span>
        )}
      </h2>
      {invitations.error && (
        <Notice tone="danger">{invitations.error.message}</Notice>
      )}
      <ul>
        {events.map((event) => (
          <InvitationRow
            key={event.key}
            event={event}
            zone={zone}
            today={today}
          />
        ))}
      </ul>
      {invitations.isSuccess && events.length === 0 && (
        <p className="px-1 py-3 text-sm text-secondary">
          Nothing waiting for an answer.
        </p>
      )}
    </section>
  );
}

const countText = (count: number) =>
  count === 0 ? "no events" : count === 1 ? "1 event" : `${count} events`;

function WeekStrip({
  week,
  today,
}: {
  week: WeekDay<ShownEvent>[];
  today: CivilDate;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-line p-3">
      <div className="flex items-baseline justify-between px-1 text-[13px]">
        <h2 className="font-semibold text-secondary">This week</h2>
        <Link
          to="/calendar/schedule"
          className={`inline-flex min-h-6 items-center rounded text-accent hover:underline ${FOCUS}`}
        >
          Open schedule
        </Link>
      </div>
      <ul className="grid grid-cols-7 gap-1">
        {week.map(({ date, events }) => {
          const isToday = date === today;
          return (
            <li key={date}>
              <Link
                to="/calendar/schedule"
                search={searchOf("day", date)}
                aria-label={`${dayTitle(date, today)}, ${countText(events.length)}`}
                aria-current={isToday ? "date" : undefined}
                className={`flex h-full flex-col items-center gap-1 rounded py-2 text-[13px] ${isToday ? "bg-selected text-accent" : "text-secondary hover:bg-field"} ${FOCUS}`}
              >
                {weekdayShort(date)}
                <span
                  className={`text-lg leading-none font-semibold ${isToday ? "text-accent" : "text-text"}`}
                >
                  {dayNumber(date)}
                </span>
                <span className="flex min-h-1.5 gap-[3px]" aria-hidden>
                  {events.slice(0, MOST_DOTS).map((event) => (
                    <span
                      key={event.key}
                      className={`size-1.5 rounded-full ${calendarFill(event.calendar.colour)}`}
                    />
                  ))}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EventRow({
  event,
  day,
  startOnly = false,
  finished = false,
  zone,
  today,
}: {
  event: ShownEvent;
  day: CivilDate;
  startOnly?: boolean;
  finished?: boolean;
  zone: TimeZone;
  today: CivilDate;
}) {
  const label = spokenLabel(event, zone, today);
  return (
    <li>
      <EventLink
        event={event}
        day={day}
        label={finished ? `${label}, finished` : label}
        className={`${ROW} ${startOnly ? START_COLUMNS : SPAN_COLUMNS} ${finished ? "text-secondary" : ""}`}
      >
        <span className="text-secondary tabular-nums">
          {hoursText(hoursOnDay(event.time, day, zone), startOnly)}
        </span>
        <span
          aria-hidden
          className={`size-2 rounded-sm ${calendarFill(event.calendar.colour)}`}
        />
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{event.title}</span>
          {event.location && (
            <span className="truncate text-xs text-secondary">
              {event.location}
            </span>
          )}
          {finished && (
            <span className="ml-auto flex-none text-xs text-secondary">
              Finished
            </span>
          )}
        </span>
      </EventLink>
    </li>
  );
}

function RestOfToday({
  plan,
  zone,
}: {
  plan: TodayPlan<ShownEvent>;
  zone: TimeZone;
}) {
  const [showFinished, setShowFinished] = useState(false);
  const { finished, ahead, today } = plan;
  const row = (event: ShownEvent, done: boolean) => (
    <EventRow
      key={event.key}
      event={event}
      day={today}
      finished={done}
      zone={zone}
      today={today}
    />
  );
  return (
    <section className="min-w-0">
      <h2 className={SECTION}>Rest of today</h2>
      <ul>
        {finished.length > 0 && !showFinished && (
          <li className="flex items-center gap-2 border-b border-line px-1 py-2 text-sm text-secondary">
            <IconCheck size={15} stroke={1.75} aria-hidden />
            {finished.length} finished earlier
            <button
              type="button"
              className={`min-h-6 cursor-pointer rounded text-accent hover:underline ${FOCUS}`}
              onClick={() => setShowFinished(true)}
            >
              Show
            </button>
          </li>
        )}
        {showFinished && finished.map((event) => row(event, true))}
        {showFinished && finished.length > 0 && (
          <li className="border-b border-line px-1 py-2 text-sm">
            <button
              type="button"
              className={`min-h-6 cursor-pointer rounded text-accent hover:underline ${FOCUS}`}
              onClick={() => setShowFinished(false)}
            >
              Hide finished
            </button>
          </li>
        )}
        {ahead.map((event) => row(event, false))}
      </ul>
      {ahead.length === 0 && (
        <p className="px-1 py-3 text-sm text-secondary">
          {plan.next.kind === "today"
            ? "Nothing else after that."
            : "That's everything for today."}
        </p>
      )}
    </section>
  );
}

function Tomorrow({
  plan,
  zone,
}: {
  plan: TodayPlan<ShownEvent>;
  zone: TimeZone;
}) {
  const later = plan.next.kind === "tomorrow";
  return (
    <section className="min-w-0">
      <h2 className={SECTION}>
        {later ? "Later tomorrow" : "Tomorrow"}
        <span className="text-[13px] font-normal text-secondary">
          {dayTitle(plan.tomorrow, plan.today)}
        </span>
      </h2>
      <ul>
        {plan.tomorrowEvents.map((event) => (
          <EventRow
            key={event.key}
            event={event}
            day={plan.tomorrow}
            startOnly
            zone={zone}
            today={plan.today}
          />
        ))}
      </ul>
      {plan.tomorrowEvents.length === 0 && (
        <p className="px-1 py-3 text-sm text-secondary">
          {later ? "Nothing else tomorrow." : "Nothing on tomorrow yet."}
        </p>
      )}
    </section>
  );
}

function AllDayChip({
  event,
  zone,
  today,
}: {
  event: ShownEvent;
  zone: TimeZone;
  today: CivilDate;
}) {
  return (
    <EventLink
      event={event}
      day={today}
      label={spokenLabel(event, zone, today)}
      className={`flex max-w-full min-w-0 items-baseline gap-1.5 rounded px-2 py-0.5 text-[13px] ${calendarTint(event.calendar.colour)} ${FOCUS}`}
    >
      <span className="flex-none font-semibold">All day</span>
      <span className="truncate">{event.title}</span>
    </EventLink>
  );
}

function Heading({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 px-4 pt-3.5 pb-2.5">
      <h1 className="text-[21px] font-semibold">Today</h1>
      {children}
    </div>
  );
}

function LiveToday() {
  const [zone] = useState(deviceZone);
  const now = useMinute();
  const today = todayIn(zone, now);
  const window = useMemo(() => todayWindow(today), [today]);
  const calendars = useQuery(calendarsQuery());
  const listing = useQuery(eventsQuery(window));
  // An event called off, or one the person said No to, isn't part of their day. Schedule
  // still shows both, struck through.
  const events = useMemo(
    () =>
      shownEvents(listing.data, calendars.data).filter(
        (event) => !event.cancelled && event.answer !== "no",
      ),
    [listing.data, calendars.data],
  );
  const plan = useMemo(
    () => planToday(events, zone, today, now),
    [events, zone, today, now],
  );
  const failure = calendars.error ?? listing.error;
  const ready = listing.data && calendars.data;

  return (
    <>
      <Heading>
        <p className="text-secondary">{dayTitle(today, today)}</p>
        {plan.allDay.map((event) => (
          <AllDayChip key={event.key} event={event} zone={zone} today={today} />
        ))}
      </Heading>
      <div
        className="flex flex-col gap-5 px-4 pb-6"
        aria-busy={(!ready && !failure) || undefined}
      >
        {failure && <Notice tone="danger">{failure.message}</Notice>}
        {!ready && !failure && (
          <p className="px-1 py-3 text-sm text-secondary">Loading your day…</p>
        )}
        {listing.data && !listing.data.complete && (
          <Notice tone="info">
            There are too many events this week to show them all.
          </Notice>
        )}
        {ready && (
          <>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
              <NextCard next={plan.next} plan={plan} zone={zone} now={now} />
              <WeekStrip week={plan.week} today={today} />
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <RestOfToday key={today} plan={plan} zone={zone} />
              <Tomorrow plan={plan} zone={zone} />
            </div>
          </>
        )}
        {/* It loads on its own, so invitations still show when the events can't. */}
        {(ready || failure) && <Invitations zone={zone} today={today} />}
      </div>
    </>
  );
}

function Today() {
  // The server knows neither the reader's time zone nor their language, so the day
  // waits for the browser. The events are already here by then.
  const hydrated = useHydrated();
  return hydrated ? <LiveToday /> : <Heading />;
}

export function TodayScreen({
  prefetched,
}: {
  prefetched: DehydratedState | undefined;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <Today />
    </HydrationBoundary>
  );
}
