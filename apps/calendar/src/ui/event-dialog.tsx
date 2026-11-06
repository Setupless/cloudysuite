import type { CalendarId, UserId } from "@cloudysuite/access";
import { Button, Modal, Notice } from "@cloudysuite/ui";
import {
  IconCalendarX,
  IconMail,
  IconMapPin,
  IconRepeat,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { call, calendarKeys, outsideInvitingQuery } from "../queries";
import {
  type CalendarEntry,
  type ChangeScope,
  type CivilDate,
  type EventDraft,
  type EventUid,
  MAX_LOCATION_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_REPEAT_TIMES,
  MAX_TITLE_LENGTH,
  NEVER_HAPPENS_MESSAGE,
  type OutsideInviting,
  REPEAT_FREQUENCIES,
  type TimeZone,
} from "../types";
import { calendarFill } from "./colours";
import {
  draftOf,
  WEEKEND_ONLY_MESSAGE,
  weekendOnly,
  type EventAction,
  type EventForm,
  type FormField,
  type FormStart,
  formOf,
  type Guest,
  guestKey,
  guestName,
  newForm,
  SCOPE_LABELS,
  scopesFor,
  withStart,
  writableCalendars,
} from "./event-form";
import { REPEAT_NAMES, whoCanSee } from "./event-text";
import { useMe } from "./me";
import { PeoplePicker } from "./people-picker";
import { daySpanOf } from "./schedule-layout";
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

// Each person's own, because people can share a browser.
const lastUsedKey = (me: UserId) => `cloudysuite.calendar.lastUsed.${me}`;

export type Opening =
  | { kind: "new"; start: FormStart }
  | (Extract<EventAction, { kind: "edit" }> & { event: ShownEvent });

// A personal calendar has no id until it's first used.
type Choice = CalendarId | "personal";
const choiceOf = (entry: CalendarEntry): Choice => entry.id ?? "personal";

// Storage can be turned off in the browser, and then the personal calendar comes first.
function lastUsed(me: UserId): string | null {
  try {
    return localStorage.getItem(lastUsedKey(me));
  } catch {
    return null;
  }
}

function rememberUsed(me: UserId, calendarId: CalendarId): void {
  try {
    localStorage.setItem(lastUsedKey(me), calendarId);
  } catch {
    return;
  }
}

const firstChoice = (
  writable: CalendarEntry[],
  me: UserId,
): Choice | undefined => {
  const last = lastUsed(me);
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

// Why addresses can't be invited, said before saving. Emails go from the organiser's own
// address, whoever makes the change.
function outsideNote(
  inviting: OutsideInviting | "checking" | "unknown",
  organiserIsMe: boolean,
  organiserName: string | null,
): string | null {
  switch (inviting) {
    case "ready":
      return null;
    case "checking":
      return "Checking whether invitations can be emailed…";
    case "unknown":
      return "We couldn't check whether invitations can be emailed, so only people in your organisation can be added. Close the event and open it again to try again.";
    case "mailOff":
      return "Mail is off, so people outside your organisation can't be invited and won't get an email. Colleagues still see it in their calendar.";
    case "noSender":
      return organiserIsMe
        ? "You don't have a personal mailbox, so you can only invite people in your organisation. Invitations to anyone else go from your own address."
        : `Emails can't go from ${organiserName ?? "the organiser"}'s address, so people outside your organisation can't be invited and won't hear about this change.`;
  }
}

function InviteField({
  guests,
  event,
  organiser,
  organiserName,
  disabled,
  onChange,
}: {
  guests: Guest[];
  // The event being changed, or null for a new one.
  event: { calendarId: CalendarId; uid: EventUid } | null;
  // Whose address the emails go from, who is never one of their own guests.
  organiser: UserId;
  organiserName: string | null;
  disabled: boolean;
  onChange: (guests: Guest[]) => void;
}) {
  const headingId = useId();
  const me = useMe();
  const query = useQuery(outsideInvitingQuery(event));
  const inviting = query.isPending
    ? "checking"
    : query.isError
      ? "unknown"
      : query.data;
  const note = outsideNote(inviting, organiser === me, organiserName);
  const skip = new Set<string>([
    organiser,
    ...guests.map((guest) =>
      guest.kind === "colleague" ? guest.userId : guest.email,
    ),
  ]);
  return (
    <div role="group" aria-labelledby={headingId} className={LABEL}>
      <span id={headingId}>Invite people</span>
      {guests.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {guests.map((guest) => (
            <li
              key={guestKey(guest)}
              className="flex items-center gap-1 rounded bg-selected py-0.5 pr-0.5 pl-2 text-[13px] font-normal text-text"
            >
              {guest.kind === "outside" && (
                <IconMail
                  size={14}
                  stroke={1.75}
                  aria-hidden
                  className="text-secondary"
                />
              )}
              <span dir="auto">{guestName(guest)}</span>
              <button
                type="button"
                aria-label={`Don't invite ${guestName(guest)}`}
                disabled={disabled}
                className="flex size-6 cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:bg-field focus-visible:outline-2"
                onClick={() =>
                  onChange(guests.filter((other) => other !== guest))
                }
              >
                <IconX size={14} stroke={1.75} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <PeoplePicker
        label="Invite people"
        skip={skip}
        adding={null}
        disabled={disabled}
        onAdd={async (person) =>
          onChange([
            ...guests,
            { kind: "colleague", userId: person.id, name: person.name },
          ])
        }
        addresses={{
          refused:
            note &&
            "People outside your organisation can't be invited to this event. The note below says why.",
          onAdd: (email) => onChange([...guests, { kind: "outside", email }]),
        }}
      />
      <span className="font-normal text-secondary">
        {note ??
          "Colleagues see it in their own calendar straight away. People outside your organisation, and colleagues with a mailbox, get an email they can answer from any calendar or mail app."}
      </span>
    </div>
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
  // `firstDay` is the day a new event first happens, and null after a change.
  onSaved: (uid: EventUid, firstDay: CivilDate | null) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const me = useMe();
  const editing = opening.kind === "edit" ? opening.event : null;
  const place = opening.kind === "edit" ? opening.place : null;
  const [form, setForm] = useState(() =>
    opening.kind === "edit"
      ? formOf(opening.event, zone)
      : newForm(opening.start, zone),
  );
  const writable = writableCalendars(calendars);
  const [choice, setChoice] = useState(() => firstChoice(writable, me));
  // The organiser is never one of their own guests.
  const organiser =
    editing && editing.organiser.kind !== "outside"
      ? editing.organiser.userId
      : me;
  const organiserName =
    editing && editing.organiser.kind !== "outside"
      ? editing.organiser.name
      : null;
  const organised =
    place && editing && editing.organiser.kind !== "outside"
      ? { calendarId: place.calendarId, uid: place.target.uid }
      : null;
  const chosen = writable.find((entry) => choiceOf(entry) === choice);
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
      let firstDay: CivilDate | null = null;
      if (place) {
        await call(() =>
          updateEvent({
            data: {
              calendarId: place.calendarId,
              target: place.target,
              scope: changeScope,
              draft,
            },
          }),
        );
        uid = place.target.uid;
      } else {
        const calendarId =
          !choice || choice === "personal"
            ? await call(() => ensureMyCalendar())
            : choice;
        const created = await call(() =>
          createEvent({ data: { calendarId, draft } }),
        );
        uid = created.uid;
        firstDay = daySpanOf(created.first, zone).first;
        rememberUsed(me, calendarId);
      }
      await client.invalidateQueries({ queryKey: calendarKeys.all });
      onSaved(uid, firstDay);
    } catch (thrown) {
      const { message } = thrown as Error;
      // The end day to change is on the form, not on the choice of which ones.
      const endTooSoon = message === NEVER_HAPPENS_MESSAGE;
      if (endTooSoon) setAsking(null);
      setFailure({ field: endTooSoon ? "repeatUntil" : null, message });
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
    if (!editing && weekendOnly(checked.draft)) {
      setFailure({ field: "repeatUntil", message: WEEKEND_ONLY_MESSAGE });
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
          className={`grid gap-2 max-sm:grid-cols-2 ${sameDayTimed ? "grid-cols-[1.4fr_1fr_1fr]" : "grid-cols-[1.4fr_1fr]"}`}
        >
          {/* On a phone the fields split evenly, or their times and dates get cut off, and
              the day gets its own row rather than sharing it three ways. */}
          <label
            className={`${LABEL} ${sameDayTimed ? "max-sm:col-span-2" : ""}`}
          >
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
        {place ? (
          <div className={LABEL}>
            Calendar
            <span className="flex items-center gap-2 py-0.5 text-sm font-normal text-text">
              <CalendarSwatch colour={place.calendar.colour} />
              <span dir="auto" className="min-w-0 truncate">
                {place.calendar.name}
              </span>
            </span>
            <SeenBy entry={place.calendar} />
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
        <InviteField
          guests={form.people}
          event={organised}
          organiser={organiser}
          organiserName={organiserName}
          disabled={pending}
          onChange={(people) => set({ people })}
        />
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
  action: { kind, place },
  onDone,
  onClose,
}: {
  event: ShownEvent;
  action: Extract<EventAction, { kind: "delete" | "remove" }>;
  onDone: () => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const removing = kind === "remove";
  const scopes = scopesFor(event, null);
  const [scope, setScope] = useState<ChangeScope>("this");
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { calendar } = place;
  const team = calendar.kind === "team";

  async function confirm() {
    setPending(true);
    setFailure(null);
    try {
      await call(() =>
        deleteEvent({
          data: {
            calendarId: place.calendarId,
            target: place.target,
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
          ? `Remove ${event.title} from ${team ? calendar.name : "your calendar"}?`
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
            {team && `It goes for everyone on ${calendar.name}. `}
            This can't be undone.
          </p>
        )
      )}
      {!removing && event.people.length > 0 && (
        <p className="text-sm text-secondary">
          Everyone invited sees it as cancelled in their own calendar.
        </p>
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
