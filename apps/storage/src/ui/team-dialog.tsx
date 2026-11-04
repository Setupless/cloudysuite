import type { DriveId, DriveRole } from "@cloudysuite/access";
import {
  Avatar,
  Button,
  Modal,
  Notice,
  Spinner,
  useToast,
} from "@cloudysuite/ui";
import { IconX } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  addMembers,
  changeMemberRole,
  leaveTeamFolder,
  removeTeamMember,
} from "../sharing-functions";
import { accessQuery, call, storageKeys } from "../queries";
import { ACCESS_LABELS } from "./access-labels";
import { LEVEL_SELECT, PeoplePicker } from "./people-picker";

const ROLES = [
  { value: "editor", label: "Can edit" },
  { value: "viewer", label: "Can view" },
  { value: "manager", label: "Manager" },
] as const;

// The change being saved. The role is kept so the menu shows what was picked, not what
// it was, until the saved list comes back.
type Running =
  | { kind: "role"; personId: string; role: DriveRole }
  | { kind: "remove"; personId: string }
  | { kind: "leave" }
  | null;

export function TeamDialog({
  driveId,
  name,
  meId,
  onClose,
}: {
  driveId: DriveId;
  name: string;
  meId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const access = useQuery(accessQuery(driveId, null));
  const { data } = access;
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Running>(null);
  const canManage = data?.myRole === "manager";
  const lines = data?.lines ?? [];

  const refresh = () => client.invalidateQueries({ queryKey: storageKeys.all });
  async function run(action: Running, change: () => Promise<unknown>) {
    setRunning(action);
    setError(null);
    try {
      await call(change);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setRunning(null);
    }
  }

  // Leaving closes this with the page, so it only stops running if it fails.
  async function leave() {
    setRunning({ kind: "leave" });
    setError(null);
    try {
      await call(() => leaveTeamFolder({ data: { driveId } }));
      await navigate({ to: "/storage" });
      await refresh();
      toast({ message: `You've left ${name}.` });
    } catch (failure) {
      setError((failure as Error).message);
      setRunning(null);
    }
  }
  const runningOn = (personId: string) =>
    running && running.kind !== "leave" && running.personId === personId
      ? running
      : null;

  return (
    <Modal
      title={`People on ${name}`}
      onClose={onClose}
      closeButton
      busy={running?.kind === "leave"}
    >
      {canManage && (
        <PeoplePicker<DriveRole>
          levels={ROLES}
          initialLevel="editor"
          skip={new Set(lines.map((line) => line.person.id))}
          onAdd={async (audience, role) => {
            const { added } = await call(() =>
              addMembers({ data: { driveId, audience, role } }),
            );
            await refresh();
            if (audience.kind === "team") {
              toast({
                message: `Added ${added === 1 ? "1 person" : `${added} people`} from that team folder.`,
              });
            }
          }}
        />
      )}
      {access.isError && <Notice tone="danger">{access.error.message}</Notice>}
      {access.isPending && (
        <p
          role="status"
          className="flex items-center gap-2 py-2 text-sm text-secondary"
        >
          <Spinner size={16} />
          Getting the people on it…
        </p>
      )}
      <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
        {lines.map(({ person, access: role }) => {
          const mine = runningOn(person.id);
          return (
            <li key={person.id} className="flex items-center gap-2 text-sm">
              <Avatar person={person} size="small" />
              <span className="mr-auto min-w-0 truncate">
                {person.name}
                {person.id === meId && (
                  <span className="text-secondary"> (you)</span>
                )}
              </span>
              {canManage ? (
                <>
                  {mine?.kind === "role" && (
                    <span className="flex-none text-secondary">
                      <Spinner size={16} />
                    </span>
                  )}
                  <select
                    aria-label={`What ${person.name} can do`}
                    value={mine?.kind === "role" ? mine.role : role}
                    disabled={running !== null}
                    aria-busy={mine?.kind === "role" || undefined}
                    className={LEVEL_SELECT}
                    onChange={(event) => {
                      const next = event.target.value as DriveRole;
                      void run(
                        { kind: "role", personId: person.id, role: next },
                        () =>
                          changeMemberRole({
                            data: { driveId, userId: person.id, role: next },
                          }),
                      );
                    }}
                  >
                    {ROLES.map(({ value, label }) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {person.id !== meId && (
                    <button
                      type="button"
                      aria-label={`Remove ${person.name}`}
                      disabled={running !== null}
                      aria-busy={mine?.kind === "remove" || undefined}
                      className="flex-none cursor-pointer rounded p-1 text-secondary outline-accent hover:bg-field focus-visible:outline-2"
                      onClick={() =>
                        void run({ kind: "remove", personId: person.id }, () =>
                          removeTeamMember({
                            data: { driveId, userId: person.id },
                          }),
                        )
                      }
                    >
                      {mine?.kind === "remove" ? (
                        <Spinner size={16} />
                      ) : (
                        <IconX size={16} stroke={1.75} aria-hidden />
                      )}
                    </button>
                  )}
                </>
              ) : (
                <em className="flex-none text-xs text-secondary not-italic">
                  {ACCESS_LABELS[role]}
                </em>
              )}
            </li>
          );
        })}
      </ul>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-between gap-2">
        <Button
          variant="toolbar"
          disabled={running !== null}
          pending={running?.kind === "leave"}
          onClick={() => void leave()}
        >
          Leave this team folder
        </Button>
        <Button
          variant="toolbarAction"
          disabled={running?.kind === "leave"}
          onClick={onClose}
        >
          Done
        </Button>
      </div>
    </Modal>
  );
}
