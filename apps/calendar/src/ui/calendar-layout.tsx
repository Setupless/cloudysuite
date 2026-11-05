import type { SignedIn } from "@cloudysuite/auth/session";
import { SuiteShell } from "@cloudysuite/auth/shell";
import { NAV_ITEM, NAV_ITEM_ACTIVE, useToast } from "@cloudysuite/ui";
import type { CalendarId, UserId } from "@cloudysuite/access";
import {
  IconCalendarWeek,
  IconCheck,
  IconDots,
  IconHome,
  IconPlus,
} from "@tabler/icons-react";
import {
  type DehydratedState,
  HydrationBoundary,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import {
  createTeamCalendar,
  ensureMyCalendar,
  setCalendarHidden,
} from "../functions";
import { call, calendarKeys, calendarsQuery } from "../queries";
import type { CalendarEntry } from "../types";
import { CalendarSettings } from "./calendar-settings";
import { calendarBorder, calendarFill } from "./colours";
import { MeProvider } from "./me";
import { NameDialog } from "./name-dialog";
import { SearchBox } from "./search-box";

// A personal calendar has no id until it's first used.
type SettingsFor = CalendarId | "personal";
const settingsKey = (entry: CalendarEntry): SettingsFor =>
  entry.kind === "personal" ? "personal" : (entry.id as CalendarId);

const itemClass = (active: boolean) =>
  `${NAV_ITEM} ${active ? NAV_ITEM_ACTIVE : ""}`;

function CalendarToggle({
  entry,
  onSettings,
}: {
  entry: CalendarEntry;
  onSettings: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const shown = !entry.hidden;

  async function toggle() {
    const hidden = shown;
    client.setQueryData<CalendarEntry[]>(calendarKeys.calendars, (entries) =>
      entries?.map((other) => (other === entry ? { ...other, hidden } : other)),
    );
    try {
      // A personal calendar is made the first time it's used, and this is a use.
      const calendarId = entry.id ?? (await call(() => ensureMyCalendar()));
      await call(() => setCalendarHidden({ data: { calendarId, hidden } }));
    } catch (failure) {
      toast({ message: (failure as Error).message, tone: "danger" });
    }
    await client.invalidateQueries({ queryKey: calendarKeys.all });
  }

  return (
    <div className="group relative">
      <label
        className={`${NAV_ITEM} cursor-pointer group-focus-within:pr-9 group-hover:pr-9 [@media(hover:none)]:pr-9`}
      >
        <input
          type="checkbox"
          className="peer sr-only"
          checked={shown}
          onChange={() => void toggle()}
        />
        <span
          aria-hidden
          className={`flex size-4 flex-none items-center justify-center rounded-[4px] border-2 text-on-avatar outline-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 ${calendarBorder(entry.colour)} ${shown ? calendarFill(entry.colour) : ""}`}
        >
          {shown && <IconCheck size={12} stroke={3} />}
        </span>
        <span className="min-w-0 truncate">{entry.name}</span>
        {entry.kind === "personal" && (
          <span className="ml-auto text-xs text-secondary group-focus-within:hidden group-hover:hidden">
            You
          </span>
        )}
      </label>
      {/* Shown on hover or focus, and always on a device that can't hover, such as a phone. */}
      <button
        type="button"
        aria-label={`Settings for ${entry.name}`}
        className="absolute top-1/2 right-1 flex -translate-y-1/2 cursor-pointer rounded p-1 text-secondary opacity-0 outline-accent group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-panel hover:text-text focus-visible:outline-2 [@media(hover:none)]:opacity-100"
        onClick={onSettings}
      >
        <IconDots size={16} stroke={1.75} aria-hidden />
      </button>
    </div>
  );
}

function Navigation({
  calendars,
  onSettings,
  onNewTeamCalendar,
}: {
  calendars: CalendarEntry[] | undefined;
  onSettings: (key: SettingsFor) => void;
  onNewTeamCalendar: () => void;
}) {
  const { pathname } = useLocation();
  const isToday = ["", "/calendar"].includes(pathname.replace(/\/$/, ""));
  return (
    <>
      <Link
        to="/calendar"
        activeOptions={{ exact: true }}
        className={itemClass(isToday)}
      >
        <IconHome size={18} stroke={1.75} aria-hidden />
        Today
      </Link>
      <Link
        to="/calendar/schedule"
        className={itemClass(pathname.endsWith("/schedule"))}
      >
        <IconCalendarWeek size={18} stroke={1.75} aria-hidden />
        Schedule
      </Link>
      <h3 className="px-2.5 pt-3 pb-1 text-xs font-semibold text-secondary">
        Calendars
      </h3>
      {calendars?.map((entry) => (
        <CalendarToggle
          key={entry.id ?? "personal"}
          entry={entry}
          onSettings={() => onSettings(settingsKey(entry))}
        />
      ))}
      <button
        type="button"
        className={`${NAV_ITEM} cursor-pointer`}
        onClick={onNewTeamCalendar}
      >
        <span className="flex items-center gap-2.5 text-secondary">
          <IconPlus size={18} stroke={1.75} aria-hidden />
          New team calendar
        </span>
      </button>
    </>
  );
}

function Shell({ user, children }: { user: SignedIn; children: ReactNode }) {
  const client = useQueryClient();
  const { data: calendars } = useQuery(calendarsQuery());
  const [naming, setNaming] = useState(false);
  const [settingsFor, setSettingsFor] = useState<SettingsFor | null>(null);
  // Gone from the list once it's deleted or left, which closes its settings.
  const settingsEntry = calendars?.find(
    (entry) => settingsKey(entry) === settingsFor,
  );
  return (
    <SuiteShell
      app="calendar"
      user={user}
      navigationLabel="Calendar"
      headerContent={<SearchBox />}
      navigation={
        <Navigation
          calendars={calendars}
          onSettings={setSettingsFor}
          onNewTeamCalendar={() => setNaming(true)}
        />
      }
    >
      {children}
      {settingsEntry && (
        <CalendarSettings
          entry={settingsEntry}
          meId={user.id}
          onClose={() => setSettingsFor(null)}
        />
      )}
      {naming && (
        <NameDialog
          title="New team calendar"
          hint="You'll manage it, and anyone you add later will see its events."
          submitLabel="Create team calendar"
          onSubmit={async (name) => {
            await call(() => createTeamCalendar({ data: { name } }));
            await client.invalidateQueries({ queryKey: calendarKeys.all });
          }}
          onClose={() => setNaming(false)}
        />
      )}
    </SuiteShell>
  );
}

export function CalendarLayout({
  user,
  prefetched,
  children,
}: {
  user: SignedIn;
  prefetched: DehydratedState | undefined;
  children: ReactNode;
}) {
  return (
    <HydrationBoundary state={prefetched}>
      <MeProvider id={user.id as UserId}>
        <Shell user={user}>{children}</Shell>
      </MeProvider>
    </HydrationBoundary>
  );
}
