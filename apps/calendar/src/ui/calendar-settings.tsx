import type { CalendarId, CalendarRole } from "@cloudysuite/access";
import {
  Button,
  ColourChoice,
  MemberLine,
  Modal,
  Notice,
  RenameForm,
  ROLE_CHOICES,
  ROLE_SELECT,
  SETTINGS_HEADING as HEADING,
  useToast,
  Working,
} from "@cloudysuite/ui";
import {
  IconDoorExit,
  IconFileImport,
  IconTrash,
  IconTrashX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  addMembers,
  changeMemberRole,
  deleteTeamCalendar,
  ensureMyCalendar,
  importCalendarFile,
  leaveTeamCalendar,
  removeCalendarMember,
  renameTeamCalendar,
  setCalendarColour,
} from "../functions";
import {
  call,
  calendarKeys,
  eventCountQuery,
  membersQuery,
  unsentCancellationsQuery,
} from "../queries";
import { startDateOf } from "../time";
import {
  type CalendarEntry,
  IMPORT_TOO_LARGE_MESSAGE,
  MAX_IMPORT_BYTES,
} from "../types";
import { dayAndMonth } from "./event-text";
import { importLines } from "./import-text";
import { NotSentLine } from "./invitation-parts";
import { PeoplePicker } from "./people-picker";

// The change being saved. A role or colour is kept so the control shows what was picked,
// not what it was, until the saved calendar comes back.
type Running =
  | { kind: "rename" }
  | { kind: "colour"; colour: number }
  | { kind: "role"; personId: string; role: CalendarRole }
  | { kind: "remove"; personId: string }
  | { kind: "add"; name: string }
  | { kind: "import" }
  | { kind: "leave" }
  | { kind: "delete" }
  | null;

function useRunning() {
  const client = useQueryClient();
  const [running, setRunning] = useState<Running>(null);
  const [error, setError] = useState<string | null>(null);
  // Throws, so the people picker can show what went wrong with an add. `before` runs
  // ahead of the refresh, so a dialog for a calendar that's gone closes first and doesn't
  // ask about it again.
  async function hold(
    action: Running,
    change: () => Promise<unknown>,
    before?: () => void,
  ) {
    setRunning(action);
    setError(null);
    try {
      await call(change);
      before?.();
      await client.invalidateQueries({ queryKey: calendarKeys.all });
    } finally {
      setRunning(null);
    }
  }
  async function run(
    action: Running,
    change: () => Promise<unknown>,
    before?: () => void,
  ) {
    try {
      await hold(action, change, before);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return { running, error, setError, hold, run };
}

function ImportEvents({
  calendarId,
  disabled,
  pending,
  onImport,
  onRefuse,
}: {
  calendarId: () => Promise<CalendarId>;
  disabled: boolean;
  pending: boolean;
  onImport: (change: () => Promise<unknown>) => void;
  onRefuse: (message: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [summary, setSummary] = useState<{
    file: string;
    lines: string[];
  } | null>(null);
  function choose(file: File | undefined) {
    if (picker.current) picker.current.value = "";
    if (!file) return;
    setSummary(null);
    if (file.size > MAX_IMPORT_BYTES) {
      onRefuse(IMPORT_TOO_LARGE_MESSAGE);
      return;
    }
    onImport(async () => {
      const result = await importCalendarFile({
        data: {
          calendarId: await calendarId(),
          file: await file.text(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      });
      setSummary({ file: file.name, lines: importLines(result) });
    });
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className={HEADING}>Import</h3>
      <p className="text-sm text-secondary">
        Add events from a calendar file, the .ics kind that Google Calendar,
        Outlook, and Apple Calendar save.
      </p>
      <input
        ref={picker}
        type="file"
        accept=".ics,text/calendar"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => choose(event.target.files?.[0])}
      />
      <span className="self-start">
        <Button
          variant="quiet"
          icon={IconFileImport}
          disabled={disabled}
          pending={pending}
          onClick={() => picker.current?.click()}
        >
          {pending ? "Importing…" : "Import events from a file"}
        </Button>
      </span>
      {summary && (
        <div
          role="status"
          className="flex flex-col gap-1 rounded bg-sidebar px-3 py-2 text-sm text-text"
        >
          <p className="font-medium break-words">From {summary.file}:</p>
          {summary.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </section>
  );
}

function PersonalSettings({
  entry,
  onClose,
}: {
  entry: CalendarEntry;
  onClose: () => void;
}) {
  const { running, error, setError, run } = useRunning();
  const shown = running?.kind === "colour" ? running.colour : entry.colour;
  return (
    <Modal
      title="Your calendar"
      onClose={onClose}
      closeButton
      busy={running !== null}
    >
      <p className="text-sm text-secondary">
        Only you can see this calendar. Invitations to you land here.
      </p>
      <ColourChoice
        colour={shown}
        disabled={running !== null}
        onChoose={(colour) =>
          void run({ kind: "colour", colour }, async () => {
            // A personal calendar is made the first time it's used, and this is a use.
            const calendarId = entry.id ?? (await ensureMyCalendar());
            await setCalendarColour({ data: { calendarId, colour } });
          })
        }
      />
      <ImportEvents
        calendarId={async () => entry.id ?? (await ensureMyCalendar())}
        disabled={running !== null}
        pending={running?.kind === "import"}
        onImport={(change) => void run({ kind: "import" }, change)}
        onRefuse={setError}
      />
      {entry.id && <UnsentCancellations calendarId={entry.id} canEdit />}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end">
        <Button variant="toolbarAction" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

// A deleted event has no People list left, so an email telling someone it's off that
// didn't go is listed here instead.
function UnsentCancellations({
  calendarId,
  canEdit,
}: {
  calendarId: CalendarId;
  canEdit: boolean;
}) {
  const unsent = useQuery(unsentCancellationsQuery(calendarId));
  if (unsent.isError) {
    return <Notice tone="danger">{unsent.error.message}</Notice>;
  }
  if (!unsent.data?.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className={HEADING}>Cancellations not sent</h3>
      <p className="text-sm text-secondary">
        These events are deleted, but the email telling someone didn't go.
      </p>
      <ul className="flex max-h-60 flex-col gap-1.5 overflow-y-auto text-[13px]">
        {unsent.data.map((one) => (
          <NotSentLine
            key={`${one.uid} ${one.to.key}`}
            calendarId={calendarId}
            uid={one.uid}
            to={one.to}
            about={`${one.title}, ${dayAndMonth(startDateOf(one.time))}`}
            canRetry={canEdit}
          />
        ))}
      </ul>
    </section>
  );
}

function DeleteConfirmation({
  entry,
  calendarId,
  onBack,
  onDeleted,
}: {
  entry: CalendarEntry;
  calendarId: CalendarId;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const count = useQuery(eventCountQuery(calendarId));
  const { running, error, run } = useRunning();
  const events =
    count.data === 1 ? "its 1 event" : `its ${count.data ?? 0} events`;
  return (
    <Modal
      title={`Delete ${entry.name}?`}
      onClose={onBack}
      busy={running !== null}
    >
      {count.isPending && <Working>Counting its events…</Working>}
      {count.isError && <Notice tone="danger">{count.error.message}</Notice>}
      {count.isSuccess && (
        <p className="text-sm text-secondary">
          {count.data === 0
            ? "It has no events."
            : `Deleting it also deletes ${events}. A repeating event counts once.`}{" "}
          Everyone on it loses the calendar, and this can't be undone.
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="toolbar" disabled={running !== null} onClick={onBack}>
          Cancel
        </Button>
        <Button
          variant="danger"
          icon={IconTrashX}
          disabled={!count.isSuccess}
          pending={running?.kind === "delete"}
          onClick={() =>
            void run(
              { kind: "delete" },
              () => deleteTeamCalendar({ data: { calendarId } }),
              () => {
                toast({ message: `${entry.name} is deleted.` });
                onDeleted();
              },
            )
          }
        >
          Delete team calendar
        </Button>
      </div>
    </Modal>
  );
}

function TeamSettings({
  entry,
  calendarId,
  meId,
  onClose,
}: {
  entry: CalendarEntry;
  calendarId: CalendarId;
  meId: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const members = useQuery(membersQuery(calendarId));
  const { running, error, setError, hold, run } = useRunning();
  const [confirming, setConfirming] = useState(false);
  const [newRole, setNewRole] = useState<CalendarRole>("editor");
  const canManage = entry.role === "manager";
  const canEdit = entry.role !== "viewer";
  const busy = running !== null;
  const lines = members.data ?? [];

  if (confirming) {
    return (
      <DeleteConfirmation
        entry={entry}
        calendarId={calendarId}
        onBack={() => setConfirming(false)}
        onDeleted={onClose}
      />
    );
  }

  const runningOn = (personId: string) =>
    running &&
    (running.kind === "role" || running.kind === "remove") &&
    running.personId === personId
      ? running
      : null;

  return (
    <Modal title={entry.name} onClose={onClose} closeButton busy={busy}>
      {canManage && (
        <>
          <RenameForm
            name={entry.name}
            disabled={busy}
            pending={running?.kind === "rename"}
            onRename={(name) =>
              void run({ kind: "rename" }, () =>
                renameTeamCalendar({ data: { calendarId, name } }),
              )
            }
          />
          <ColourChoice
            colour={running?.kind === "colour" ? running.colour : entry.colour}
            disabled={busy}
            onChoose={(colour) =>
              void run({ kind: "colour", colour }, () =>
                setCalendarColour({ data: { calendarId, colour } }),
              )
            }
          />
        </>
      )}
      <h3 className={HEADING}>People</h3>
      {canManage && (
        <PeoplePicker
          label="Add a person"
          skip={new Set(lines.map((line) => line.person.id))}
          adding={running?.kind === "add" ? running.name : null}
          disabled={busy}
          onAdd={(person) =>
            hold({ kind: "add", name: person.name }, () =>
              addMembers({
                data: { calendarId, people: [person.id], role: newRole },
              }),
            )
          }
        >
          <select
            aria-label="What they can do"
            value={newRole}
            disabled={busy}
            onChange={(event) => setNewRole(event.target.value as CalendarRole)}
            className={ROLE_SELECT}
          >
            {ROLE_CHOICES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </PeoplePicker>
      )}
      {members.isError && (
        <Notice tone="danger">{members.error.message}</Notice>
      )}
      {members.isPending && <Working>Getting the people on it…</Working>}
      <ul className="flex max-h-60 flex-col gap-1.5 overflow-y-auto">
        {lines.map(({ person, role }) => {
          const mine = runningOn(person.id);
          return (
            <MemberLine
              key={person.id}
              person={person}
              role={role}
              isMe={person.id === meId}
              canManage={canManage}
              busy={busy}
              saving={mine}
              onRole={(next) =>
                void run(
                  { kind: "role", personId: person.id, role: next },
                  () =>
                    changeMemberRole({
                      data: { calendarId, userId: person.id, role: next },
                    }),
                )
              }
              onRemove={() =>
                void run({ kind: "remove", personId: person.id }, () =>
                  removeCalendarMember({
                    data: { calendarId, userId: person.id },
                  }),
                )
              }
            />
          );
        })}
      </ul>
      {canEdit && (
        <ImportEvents
          calendarId={async () => calendarId}
          disabled={busy}
          pending={running?.kind === "import"}
          onImport={(change) => void run({ kind: "import" }, change)}
          onRefuse={setError}
        />
      )}
      <UnsentCancellations calendarId={calendarId} canEdit={canEdit} />
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex gap-2">
        {canManage && (
          <Button
            variant="toolbar"
            icon={IconTrash}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        )}
        <Button
          variant="toolbar"
          icon={IconDoorExit}
          disabled={busy}
          pending={running?.kind === "leave"}
          onClick={() =>
            void run(
              { kind: "leave" },
              () => leaveTeamCalendar({ data: { calendarId } }),
              () => {
                toast({ message: `You've left ${entry.name}.` });
                onClose();
              },
            )
          }
        >
          Leave
        </Button>
        <span className="ml-auto">
          <Button variant="toolbarAction" disabled={busy} onClick={onClose}>
            Done
          </Button>
        </span>
      </div>
    </Modal>
  );
}

export function CalendarSettings({
  entry,
  meId,
  onClose,
}: {
  entry: CalendarEntry;
  meId: string;
  onClose: () => void;
}) {
  if (entry.kind === "personal" || entry.id === null) {
    return <PersonalSettings entry={entry} onClose={onClose} />;
  }
  return (
    <TeamSettings
      entry={entry}
      calendarId={entry.id}
      meId={meId}
      onClose={onClose}
    />
  );
}
