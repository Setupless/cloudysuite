import type { CalendarId } from "@cloudysuite/access";
import { Button, Modal, Notice } from "@cloudysuite/ui";
import {
  IconCalendarX,
  IconMapPin,
  IconRepeat,
  IconTrash,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  createEvent,
  deleteEvent,
  ensureMyCalendar,
  updateEvent,
} from "../functions";
import { call, calendarKeys } from "../queries";
import {
  type CalendarEntry,
  type ChangeScope,
  type EventDraft,
  type EventUid,
  MAX_LOCATION_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_REPEAT_TIMES,
  MAX_TITLE_LENGTH,
  REPEAT_FREQUENCIES,
  type TimeZone,
} from "../types";
import { calendarFill } from "./colours";
import {
  controlsFor,
  draftOf,
  type EventForm,
  type FormField,
  type FormStart,
  formOf,
  newForm,
  SCOPE_LABELS,
  scopesFor,
  withStart,
  writableCalendars,
} from "./event-form";
import { REPEAT_NAMES, whoCanSee } from "./event-text";
import type { ShownEvent } from "./shown-event";

const LABEL =
  "flex min-w-0 flex-col gap-1 text-xs font-semibold text-secondary";
const FIELD =
  "w-full min-w-0 rounded border border-line bg-field px-2.5 py-1.5 text-sm font-normal text-text outline-accent placeholder:text-secondary focus-visible:outline-2 aria-[invalid=true]:border-danger";
const WITH_ICON = "relative flex items-center";
const FIELD_ICON = "pointer-events-none absolute left-2.5 text-secondary";
const CHECK = "size-4 flex-none accent-accent";
const LINK =
  "cursor-pointer rounded text-[13px] text-accent outline-accent hover:underline focus-visible:outline-2";

const LAST_USED = "cloudysuite.calendar.lastUsed";

export type Opening =
  { kind: "new"; start: FormStart } | { kind: "edit"; event: ShownEvent };

// A personal calendar has no id until it's first used.
type Choice = CalendarId | "personal";
const choiceOf = (entry: CalendarEntry): Choice => entry.id ?? "personal";

// Storage can be turned off in the browser, and then the personal calendar comes first.
function lastUsed(): string | null {
  try {
    return localStorage.getItem(LAST_USED);
  } catch {
    return null;
  }
}

function rememberUsed(calendarId: CalendarId): void {
  try {
    localStorage.setItem(LAST_USED, calendarId);
  } catch {
    return;
  }
}

const firstChoice = (writable: CalendarEntry[]): Choice | undefined => {
  const last = lastUsed();
  const entry =
    writable.find((candidate) => candidate.id === last) ??
    writable.find((candidate) => candidate.kind === "personal") ??
    writable[0];
  return entry && choiceOf(entry);
};

type Failure = { field: FormField | null; message: string };

function ScopeChoice({
  legend,
  scopes,
  chosen,
  onChoose,
}: {
  legend: string;
  scopes: ChangeScope[];
  chosen: ChangeScope;
  onChoose: (scope: ChangeScope) => void;
}) {
  const fieldset = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    fieldset.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, []);
  return (
    <fieldset ref={fieldset} className="flex flex-col gap-2.5">
      <legend className="mb-2.5 text-sm">{legend}</legend>
      {scopes.map((scope) => (
        <label
          key={scope}
          className="flex cursor-pointer items-center gap-2.5 text-sm"
        >
          <input
            type="radio"
            name="scope"
            className={CHECK}
            checked={scope === chosen}
            onChange={() => onChoose(scope)}
          />
          {SCOPE_LABELS[scope]}
        </label>
      ))}
    </fieldset>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 pt-1">{children}</div>;
}

function CalendarSwatch({ colour }: { colour: number }) {
  return (
    <span
      aria-hidden
      className={`size-3 flex-none rounded-[4px] ${calendarFill(colour)}`}
    />
  );
}

function SeenBy({ entry }: { entry: CalendarEntry }) {
  return (
    <span className="font-normal text-secondary">
      {whoCanSee(entry)}.
      {entry.hidden &&
        " You've hidden this calendar, so the event won't show until you tick it in the list."}
    </span>
  );
}

export function EventDialog({
  opening,
  calendars,
  zone,
  onSaved,
  onClose,
}: {
  opening: Opening;
  calendars: CalendarEntry[];
  zone: TimeZone;
  onSaved: (uid: EventUid) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const editing = opening.kind === "edit" ? opening.event : null;
  const [form, setForm] = useState(() =>
    opening.kind === "edit"
      ? formOf(opening.event, zone)
      : newForm(opening.start, zone),
  );
  const writable = writableCalendars(calendars);
  const [choice, setChoice] = useState(() => firstChoice(writable));
  const chosen = editing
    ? editing.calendar
    : writable.find((entry) => choiceOf(entry) === choice);
  const [endDayAsked, setEndDayAsked] = useState(false);
  const [asking, setAsking] = useState<{
    draft: EventDraft;
    scopes: ChangeScope[];
  } | null>(null);
  const [scope, setScope] = useState<ChangeScope>("this");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const formElement = useRef<HTMLFormElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const failureId = useId();

  useEffect(() => {
    title.current?.focus();
  }, []);

  // Saving turns the button off, which takes focus away from it.
  useEffect(() => {
    if (pending || !failure) return;
    const field =
      failure.field && formElement.current?.elements.namedItem(failure.field);
    (field instanceof HTMLElement ? field : saveButton.current)?.focus();
  }, [pending, failure]);

  const set = (change: Partial<EventForm>) =>
    setForm((before) => ({ ...before, ...change }));
  const moveStart = (change: Parameters<typeof withStart>[1]) =>
    setForm((before) => withStart(before, change));
  const invalid = (field: FormField) =>
    failure?.field === field
      ? { "aria-invalid": true, "aria-describedby": failureId }
      : {};

  async function save(draft: EventDraft, changeScope: ChangeScope) {
    setPending(true);
    setFailure(null);
    try {
      let uid: EventUid;
      if (editing) {
        await call(() =>
          updateEvent({
            data: {
              calendarId: editing.calendarId,
              target: { uid: editing.uid, occurrenceId: editing.occurrenceId },
              scope: changeScope,
              draft,
            },
          }),
        );
        uid = editing.uid;
      } else {
        const calendarId =
          !choice || choice === "personal"
            ? await call(() => ensureMyCalendar())
            : choice;
        uid = await call(() => createEvent({ data: { calendarId, draft } }));
        rememberUsed(calendarId);
      }
      await client.invalidateQueries({ queryKey: calendarKeys.all });
      onSaved(uid);
    } catch (thrown) {
      setFailure({ field: null, message: (thrown as Error).message });
      setPending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const checked = draftOf(form, zone);
    if (!checked.ok) {
      setFailure({ field: checked.field, message: checked.message });
      return;
    }
    const scopes = editing && scopesFor(editing, checked.draft);
    if (scopes) {
      setFailure(null);
      setScope(scopes[0] as ChangeScope);
      setAsking({ draft: checked.draft, scopes });
      return;
    }
    void save(checked.draft, "all");
  }

  const failureNotice = failure && (
    <div id={failureId}>
      <Notice tone="danger">{failure.message}</Notice>
    </div>
  );

  if (asking) {
    return (
      <Modal title="Edit event" onClose={onClose} closeButton busy={pending}>
        <ScopeChoice
          legend="This event repeats. Which ones should change?"
          scopes={asking.scopes}
          chosen={scope}
          onChoose={setScope}
        />
        {failureNotice}
        <Actions>
          <Button
            variant="toolbar"
            disabled={pending}
            onClick={() => {
              setAsking(null);
              setFailure(null);
              requestAnimationFrame(() => saveButton.current?.focus());
            }}
          >
            Back
          </Button>
          <Button
            ref={saveButton}
            variant="toolbarAction"
            pending={pending}
            onClick={() => void save(asking.draft, scope)}
          >
            Save
          </Button>
        </Actions>
      </Modal>
    );
  }

  const showEndDay = endDayAsked || form.endDate !== form.startDate;
  const sameDayTimed = !form.allDay && !showEndDay;
  const endDay = (
    <label className={LABEL}>
      {form.allDay ? "Last day" : "End day"}
      <input
        type="date"
        name="endDate"
        className={FIELD}
        value={form.endDate}
        onChange={(event) => set({ endDate: event.target.value })}
        {...invalid("endDate")}
      />
    </label>
  );
  const endTime = (
    <label className={LABEL}>
      Ends
      <input
        type="time"
        name="endTime"
        className={FIELD}
        value={form.endTime}
        onChange={(event) => set({ endTime: event.target.value })}
        {...invalid("endTime")}
      />
    </label>
  );

  return (
    <Modal
      title={editing ? "Edit event" : "New event"}
      onClose={onClose}
      closeButton
      busy={pending}
    >
      <form
        ref={formElement}
        noValidate
        onSubmit={submit}
        className="flex flex-col gap-3"
      >
        <input
          ref={title}
          name="title"
          aria-label="Title"
          placeholder="Add a title"
          maxLength={MAX_TITLE_LENGTH}
          className={`${FIELD} py-2 text-base font-semibold`}
          value={form.title}
          onChange={(event) => set({ title: event.target.value })}
          {...invalid("title")}
        />
        <div
          className={`grid gap-2 ${sameDayTimed ? "grid-cols-[1.4fr_1fr_1fr]" : "grid-cols-[1.4fr_1fr]"}`}
        >
          <label className={LABEL}>
            Day
            <input
              type="date"
              name="startDate"
              className={FIELD}
              value={form.startDate}
              onChange={(event) => moveStart({ startDate: event.target.value })}
              {...invalid("startDate")}
            />
          </label>
          {form.allDay ? (
            showEndDay && endDay
          ) : (
            <>
              <label className={LABEL}>
                Starts
                <input
                  type="time"
                  name="startTime"
                  className={FIELD}
                  value={form.startTime}
                  onChange={(event) =>
                    moveStart({ startTime: event.target.value })
                  }
                  {...invalid("startTime")}
                />
              </label>
              {showEndDay && endDay}
              {endTime}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              name="allDay"
              className={CHECK}
              checked={form.allDay}
              onChange={(event) => set({ allDay: event.target.checked })}
            />
            All day
          </label>
          {!showEndDay && (
            <button
              type="button"
              className={LINK}
              onClick={() => {
                setEndDayAsked(true);
                requestAnimationFrame(() =>
                  (
                    formElement.current?.elements.namedItem(
                      "endDate",
                    ) as HTMLInputElement | null
                  )?.focus(),
                );
              }}
            >
              Ends on another day
            </button>
          )}
          <span className={`${WITH_ICON} ml-auto w-[11.5rem]`}>
            <IconRepeat
              size={15}
              stroke={1.75}
              className={FIELD_ICON}
              aria-hidden
            />
            <select
              name="repeat"
              aria-label="Repeat"
              className={`${FIELD} pl-8`}
              value={form.repeat}
              onChange={(event) =>
                set({ repeat: event.target.value as EventForm["repeat"] })
              }
            >
              <option value="none">Doesn't repeat</option>
              {REPEAT_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {REPEAT_NAMES[frequency]}
                </option>
              ))}
            </select>
          </span>
        </div>
        {form.repeat !== "none" && (
          <div className="grid grid-cols-2 gap-2">
            <label className={LABEL}>
              Repeat ends
              <select
                name="repeatEnd"
                className={FIELD}
                value={form.repeatEnd}
                onChange={(event) =>
                  set({
                    repeatEnd: event.target.value as EventForm["repeatEnd"],
                  })
                }
              >
                <option value="never">Never</option>
                <option value="onDate">On a day</option>
                <option value="afterTimes">After a number of times</option>
              </select>
            </label>
            {form.repeatEnd === "onDate" && (
              <label className={LABEL}>
                Last date
                <input
                  type="date"
                  name="repeatUntil"
                  className={FIELD}
                  min={form.startDate}
                  value={form.repeatUntil}
                  onChange={(event) => set({ repeatUntil: event.target.value })}
                  {...invalid("repeatUntil")}
                />
              </label>
            )}
            {form.repeatEnd === "afterTimes" && (
              <label className={LABEL}>
                Number of times
                <input
                  type="number"
                  name="repeatTimes"
                  inputMode="numeric"
                  min={1}
                  max={MAX_REPEAT_TIMES}
                  className={FIELD}
                  value={form.repeatTimes}
                  onChange={(event) => set({ repeatTimes: event.target.value })}
                  {...invalid("repeatTimes")}
                />
              </label>
            )}
          </div>
        )}
        {editing ? (
          <div className={LABEL}>
            Calendar
            <span className="flex items-center gap-2 py-0.5 text-sm font-normal text-text">
              <CalendarSwatch colour={editing.calendar.colour} />
              <span dir="auto" className="min-w-0 truncate">
                {editing.calendar.name}
              </span>
            </span>
            <SeenBy entry={editing.calendar} />
          </div>
        ) : (
          <label className={LABEL}>
            Calendar
            <span className={WITH_ICON}>
              {chosen && (
                <span className="pointer-events-none absolute left-2.5 flex">
                  <CalendarSwatch colour={chosen.colour} />
                </span>
              )}
              <select
                name="calendar"
                className={`${FIELD} pl-8`}
                value={choice}
                onChange={(event) => setChoice(event.target.value as Choice)}
              >
                {writable.map((entry) => (
                  <option key={choiceOf(entry)} value={choiceOf(entry)}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </span>
            {chosen && <SeenBy entry={chosen} />}
          </label>
        )}
        <label className={LABEL}>
          Where
          <span className={WITH_ICON}>
            <IconMapPin
              size={15}
              stroke={1.75}
              className={FIELD_ICON}
              aria-hidden
            />
            <input
              name="location"
              placeholder="Add a place"
              maxLength={MAX_LOCATION_LENGTH}
              className={`${FIELD} pl-8`}
              value={form.location}
              onChange={(event) => set({ location: event.target.value })}
            />
          </span>
        </label>
        <label className={LABEL}>
          Notes
          <textarea
            name="notes"
            rows={3}
            placeholder="Add details"
            maxLength={MAX_NOTES_LENGTH}
            className={`${FIELD} resize-y`}
            value={form.notes}
            onChange={(event) => set({ notes: event.target.value })}
          />
        </label>
        {failureNotice}
        <Actions>
          <Button variant="toolbar" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            ref={saveButton}
            type="submit"
            variant="toolbarAction"
            pending={pending}
          >
            Save
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}

export function DeleteEventDialog({
  event,
  onDone,
  onClose,
}: {
  event: ShownEvent;
  onDone: () => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const removing = controlsFor(event, event.calendar) === "removeOnly";
  const scopes = removing ? null : scopesFor(event, null);
  const [scope, setScope] = useState<ChangeScope>("this");
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const team = event.calendar.kind === "team";

  async function confirm() {
    setPending(true);
    setFailure(null);
    try {
      await call(() =>
        deleteEvent({
          data: {
            calendarId: event.calendarId,
            target: { uid: event.uid, occurrenceId: event.occurrenceId },
            scope: scopes ? scope : "all",
          },
        }),
      );
      await client.invalidateQueries({ queryKey: calendarKeys.all });
      onDone();
    } catch (thrown) {
      setFailure((thrown as Error).message);
      setPending(false);
    }
  }

  return (
    <Modal
      title={
        removing
          ? `Remove ${event.title} from ${team ? event.calendar.name : "your calendar"}?`
          : `Delete ${event.title}?`
      }
      onClose={onClose}
      busy={pending}
    >
      {scopes ? (
        <ScopeChoice
          legend="This event repeats. Which ones should go?"
          scopes={scopes}
          chosen={scope}
          onChoose={setScope}
        />
      ) : (
        !removing && (
          <p className="text-sm text-secondary">
            {team && `It goes for everyone on ${event.calendar.name}. `}
            This can't be undone.
          </p>
        )
      )}
      {failure && <Notice tone="danger">{failure}</Notice>}
      <Actions>
        <Button variant="toolbar" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          icon={removing ? IconCalendarX : IconTrash}
          pending={pending}
          onClick={() => void confirm()}
        >
          {removing ? "Remove" : "Delete"}
        </Button>
      </Actions>
    </Modal>
  );
}
