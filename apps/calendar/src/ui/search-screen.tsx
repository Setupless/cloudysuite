import { Notice, useHydrated } from "@cloudysuite/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { calendarsQuery, searchQuery } from "../queries";
import { searchOf, todayIn } from "../schedule";
import { parseEventSearch } from "../search-query";
import { deviceZone, startOfDay } from "../time";
import type { CivilDate, EventTime, TimeZone } from "../types";
import { calendarFill } from "./colours";
import { daySpanOf } from "./schedule-layout";
import {
  type ShownEvent,
  shownEvents,
  spokenLabel,
  whenOf,
} from "./shown-event";

const endOf = (time: EventTime, zone: TimeZone) =>
  time.kind === "allDay" ? startOfDay(time.endDate, zone) : time.end;

const Hint = ({ children }: { children: ReactNode }) => (
  <p className="px-4 text-sm text-secondary">{children}</p>
);

function ResultRow({
  event,
  zone,
  today,
}: {
  event: ShownEvent;
  zone: TimeZone;
  today: CivilDate;
}) {
  const { days, hours } = whenOf(event, zone, today);
  const when = [days, hours].filter(Boolean).join(" · ");
  return (
    <Link
      to="/calendar/schedule"
      search={searchOf("day", daySpanOf(event.time, zone).first, event.key)}
      aria-label={spokenLabel(event, zone, today)}
      className="mx-2 flex items-start gap-3 rounded px-2.5 py-2 outline-accent hover:bg-field focus-visible:outline-2"
    >
      <span
        aria-hidden
        className={`mt-1.5 size-2.5 flex-none rounded-full ${calendarFill(event.calendar.colour)}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {event.title}
        </span>
        <span className="block truncate text-[13px] text-secondary">
          {when}
          <span className="sm:hidden"> · {event.calendar.name}</span>
        </span>
      </span>
      <span className="max-w-[40%] flex-none truncate pt-px text-[13px] text-secondary max-sm:hidden">
        {event.calendar.name}
      </span>
    </Link>
  );
}

function Section({
  title,
  events,
  zone,
  today,
}: {
  title: string;
  events: ShownEvent[];
  zone: TimeZone;
  today: CivilDate;
}) {
  if (events.length === 0) return null;
  return (
    <section aria-label={title}>
      <h2 className="px-4 pt-3 pb-1 text-xs font-semibold text-secondary">
        {title}
      </h2>
      <div className="flex flex-col">
        {events.map((event) => (
          <ResultRow key={event.key} event={event} zone={zone} today={today} />
        ))}
      </div>
    </section>
  );
}

function LoadingRows() {
  return (
    <div aria-busy className="flex flex-col gap-3 px-4 pt-3">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-9 animate-pulse rounded bg-field" />
      ))}
    </div>
  );
}

function Results({ text }: { text: string }) {
  const [zone] = useState(deviceZone);
  const parsed = parseEventSearch(text);
  const query = useQuery({ ...searchQuery(text, zone), enabled: parsed.ok });
  const calendars = useQuery(calendarsQuery());
  const now = Date.now();
  const today = todayIn(zone, now);
  const failure = query.error ?? (calendars.data ? null : calendars.error);

  if (!parsed.ok) return <Hint>{parsed.problem}</Hint>;
  if (failure) {
    return (
      <div className="px-4">
        <Notice tone="danger">{failure.message}</Notice>
      </div>
    );
  }
  if (!query.data || !calendars.data) return <LoadingRows />;
  if (query.data.status === "problem") return <Hint>{query.data.problem}</Hint>;
  const { more, incomplete } = query.data;
  // A calendar hidden in the sidebar leaves at once, before the server has heard.
  const events = shownEvents(
    { occurrences: query.data.occurrences, complete: true },
    calendars.data,
  );
  const toCome = events.filter((event) => endOf(event.time, zone) > now);
  const past = events.filter((event) => endOf(event.time, zone) <= now);

  return (
    <>
      {incomplete && (
        <div className="px-4 pb-2.5">
          <Notice tone="info">
            Some calendars couldn't be searched. Try again in a moment.
          </Notice>
        </div>
      )}
      {events.length === 0 ? (
        !incomplete && (
          <Hint>
            Nothing matched your search. Check the spelling, or take a word out.
            Search looks at each event's title, place, and notes.
          </Hint>
        )
      ) : (
        <>
          <Section
            title="Coming up"
            events={toCome}
            zone={zone}
            today={today}
          />
          <Section title="Earlier" events={past} zone={zone} today={today} />
          {more && (
            <p className="px-4 pt-3 text-[13px] text-secondary">
              These are the closest matches. Add another word to narrow them
              down.
            </p>
          )}
        </>
      )}
    </>
  );
}

export function SearchScreen({ text }: { text: string }) {
  // The reader's time zone and language decide which events are past and how dates
  // read, and only the browser knows them.
  const hydrated = useHydrated();
  return (
    <div className="min-h-[calc(100dvh-52px)] pb-4">
      <div className="px-4 pt-3.5 pb-2.5">
        <h1 className="text-[21px] font-semibold">Search</h1>
      </div>
      {hydrated ? <Results text={text} /> : <LoadingRows />}
    </div>
  );
}
