import type { BoardId, BoardRole, UserId } from "@cloudysuite/access";
import {
  Avatar,
  Button,
  ColourChoice,
  MemberLine,
  Modal,
  Notice,
  RenameForm,
  ROLE_CHOICES,
  ROLE_SELECT,
  SETTINGS_HEADING,
  useToast,
  Working,
} from "@cloudysuite/ui";
import { IconDoorExit, IconTrash, IconTrashX } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { changeBoardSettings } from "../functions";
import {
  call,
  colleaguesQuery,
  settingsQuery,
  taskCountQuery,
  tasksKeys,
} from "../queries";
import {
  type BoardEntry,
  type Colleague,
  mayChangeSettings,
  type SettingsChange,
} from "../types";
import { assigneeChoices } from "./assignee-choices";
import { FOCUS } from "./parts";

const CHOICES_SHOWN = 8;

// The change being saved. A role or colour is kept so the control shows what was picked,
// not what it was, until the saved board comes back.
type Running =
  | { kind: "rename" }
  | { kind: "colour"; colour: number }
  | { kind: "role"; personId: UserId; role: BoardRole }
  | { kind: "remove"; personId: UserId }
  | { kind: "add"; name: string }
  | { kind: "leave" }
  | { kind: "delete" }
  | null;

function useRunning(boardId: BoardId) {
  const client = useQueryClient();
  const [running, setRunning] = useState<Running>(null);
  const [error, setError] = useState<string | null>(null);
  // `before` runs ahead of the refresh, so a dialog or page for a board that's gone closes
  // first and doesn't ask about it again.
  async function run(
    action: Running,
    change: SettingsChange,
    before?: () => Promise<void>,
  ) {
    setRunning(action);
    setError(null);
    try {
      await call(() => changeBoardSettings({ data: { boardId, change } }));
      await before?.();
      await client.invalidateQueries({ queryKey: tasksKeys.all });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setRunning(null);
    }
  }
  return { running, error, run };
}

// Everyone in the organisation who isn't on the board yet.
function AddPerson({
  memberIds,
  adding,
  disabled,
  onAdd,
}: {
  memberIds: ReadonlySet<UserId>;
  adding: string | null;
  disabled: boolean;
  onAdd: (person: Colleague, role: BoardRole) => void;
}) {
  const colleagues = useQuery(colleaguesQuery());
  const [typed, setTyped] = useState("");
  const [role, setRole] = useState<BoardRole>("editor");
  const wanted = typed.trim() !== "";
  const { others } = assigneeChoices(
    typed,
    [],
    (colleagues.data ?? []).filter((person) => !memberIds.has(person.id)),
  );
  const add = (person: Colleague) => {
    setTyped("");
    onAdd(person, role);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input
          type="search"
          value={typed}
          aria-label="Add a person"
          placeholder="Add a person"
          autoComplete="off"
          disabled={disabled}
          className={`min-w-0 flex-1 rounded border border-line bg-field px-3 py-2 text-sm text-text disabled:opacity-60 ${FOCUS}`}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            const [first] = others;
            if (wanted && first) add(first);
          }}
        />
        <select
          aria-label="What they can do"
          value={role}
          disabled={disabled}
          className={ROLE_SELECT}
          onChange={(event) => setRole(event.target.value as BoardRole)}
        >
          {ROLE_CHOICES.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {wanted && (
        <div className="flex max-h-44 flex-col overflow-y-auto">
          {others.slice(0, CHOICES_SHOWN).map((person) => (
            <button
              key={person.id}
              type="button"
              disabled={disabled}
              className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm enabled:hover:bg-field disabled:cursor-default disabled:opacity-60 ${FOCUS}`}
              onClick={() => add(person)}
            >
              <Avatar person={person} size="small" />
              <span className="min-w-0 truncate">{person.name}</span>
              <span className="ml-auto min-w-0 truncate text-xs text-secondary">
                {person.email}
              </span>
            </button>
          ))}
          {colleagues.isPending && (
            <div className="px-2 py-1.5">
              <Working>Looking for people…</Working>
            </div>
          )}
          {colleagues.isError && (
            <Notice tone="danger">{colleagues.error.message}</Notice>
          )}
          {colleagues.isSuccess && others.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-secondary">
              Nobody by that name who isn't on the board already. Only people in
              your organisation can be added.
            </p>
          )}
        </div>
      )}
      {adding !== null && (
        <div className="px-2">
          <Working>Adding {adding}…</Working>
        </div>
      )}
    </div>
  );
}

function DeleteConfirmation({
  entry,
  onBack,
  onDeleted,
}: {
  entry: BoardEntry;
  onBack: () => void;
  onDeleted: () => Promise<void>;
}) {
  const toast = useToast();
  const count = useQuery(taskCountQuery(entry.id));
  const { running, error, run } = useRunning(entry.id);
  const tasks =
    count.data === 1 ? "its 1 task" : `all ${count.data ?? 0} of its tasks`;
  return (
    <Modal
      title={`Delete ${entry.name}?`}
      onClose={onBack}
      busy={running !== null}
    >
      {count.isPending && <Working>Counting its tasks…</Working>}
      {count.isError && <Notice tone="danger">{count.error.message}</Notice>}
      {count.isSuccess && (
        <p className="text-sm text-secondary">
          {count.data === 0
            ? "It has no tasks."
            : `Deleting it also deletes ${tasks}.`}{" "}
          Everyone on it loses the board, and this can't be undone.
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
            void run({ kind: "delete" }, { kind: "delete" }, async () => {
              toast({ message: `${entry.name} is deleted.` });
              await onDeleted();
            })
          }
        >
          Delete team board
        </Button>
      </div>
    </Modal>
  );
}

// Everyone on a board sees who else is on it. Only a manager changes anything but their
// own place on it, and the server checks that again.
export function BoardSettingsDialog({
  entry,
  meId,
  onClose,
  onGone,
}: {
  entry: BoardEntry;
  meId: UserId;
  onClose: () => void;
  // The board is deleted or left, so a page showing it should go elsewhere.
  onGone: () => Promise<void>;
}) {
  const toast = useToast();
  const settings = useQuery(settingsQuery(entry.id));
  const { running, error, run } = useRunning(entry.id);
  const [confirming, setConfirming] = useState(false);
  const role = settings.data?.myRole ?? entry.role;
  const may = (kind: SettingsChange["kind"]) => mayChangeSettings(role, kind);
  const canManage = may("add");
  const busy = running !== null;
  const members = settings.data?.members ?? [];

  if (confirming) {
    return (
      <DeleteConfirmation
        entry={entry}
        onBack={() => setConfirming(false)}
        onDeleted={() => {
          onClose();
          return onGone();
        }}
      />
    );
  }

  const savingFor = (personId: UserId) =>
    running &&
    (running.kind === "role" || running.kind === "remove") &&
    running.personId === personId
      ? running
      : null;

  return (
    <Modal title={entry.name} onClose={onClose} closeButton busy={busy}>
      {may("rename") && (
        <RenameForm
          name={entry.name}
          disabled={busy}
          pending={running?.kind === "rename"}
          onRename={(name) =>
            void run({ kind: "rename" }, { kind: "rename", name })
          }
        />
      )}
      {may("setColour") && (
        <ColourChoice
          colour={running?.kind === "colour" ? running.colour : entry.colour}
          disabled={busy}
          onChoose={(colour) =>
            void run({ kind: "colour", colour }, { kind: "setColour", colour })
          }
        />
      )}
      <h3 className={SETTINGS_HEADING}>People</h3>
      {canManage && (
        <AddPerson
          memberIds={new Set(members.map((member) => member.id))}
          adding={running?.kind === "add" ? running.name : null}
          disabled={busy || !settings.isSuccess}
          onAdd={(person, newRole) =>
            void run(
              { kind: "add", name: person.name },
              { kind: "add", userId: person.id, role: newRole },
            )
          }
        />
      )}
      {settings.isError && (
        <Notice tone="danger">{settings.error.message}</Notice>
      )}
      {settings.isPending && <Working>Getting the people on it…</Working>}
      <ul className="flex max-h-60 flex-col gap-1.5 overflow-y-auto">
        {members.map((member) => (
          <MemberLine
            key={member.id}
            person={member}
            role={member.role}
            isMe={member.id === meId}
            canManage={canManage}
            busy={busy}
            saving={savingFor(member.id)}
            onRole={(next) =>
              void run(
                { kind: "role", personId: member.id, role: next },
                { kind: "setRole", userId: member.id, role: next },
              )
            }
            onRemove={() =>
              void run(
                { kind: "remove", personId: member.id },
                { kind: "remove", userId: member.id },
              )
            }
          />
        ))}
      </ul>
      {!canManage && settings.isSuccess && (
        <p className="text-sm text-secondary">
          Only a manager can add people or change the board.
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex gap-2">
        {may("delete") && (
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
            void run({ kind: "leave" }, { kind: "leave" }, () => {
              toast({ message: `You've left ${entry.name}.` });
              onClose();
              return onGone();
            })
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
