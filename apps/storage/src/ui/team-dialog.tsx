import type { DriveId, DriveRole } from "@cloudysuite/access";
import { Avatar, Button, Modal, Notice, useToast } from "@cloudysuite/ui";
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
  const { data } = useQuery(accessQuery(driveId, null));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canManage = data?.myRole === "manager";
  const lines = data?.lines ?? [];

  const refresh = () => client.invalidateQueries({ queryKey: storageKeys.all });
  async function run(change: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await call(change);
      await refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function leave() {
    setPending(true);
    setError(null);
    try {
      await call(() => leaveTeamFolder({ data: { driveId } }));
      await navigate({ to: "/storage" });
      await refresh();
      toast({ message: `You've left ${name}.` });
    } catch (failure) {
      setError((failure as Error).message);
      setPending(false);
    }
  }

  return (
    <Modal title={`People on ${name}`} onClose={onClose} closeButton>
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
      <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
        {lines.map(({ person, access }) => (
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
                <select
                  aria-label={`What ${person.name} can do`}
                  value={access}
                  disabled={pending}
                  className={LEVEL_SELECT}
                  onChange={(event) => {
                    const role = event.target.value as DriveRole;
                    void run(() =>
                      changeMemberRole({
                        data: { driveId, userId: person.id, role },
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
                    disabled={pending}
                    className="flex-none cursor-pointer rounded p-1 text-secondary outline-accent hover:bg-field focus-visible:outline-2"
                    onClick={() =>
                      void run(() =>
                        removeTeamMember({
                          data: { driveId, userId: person.id },
                        }),
                      )
                    }
                  >
                    <IconX size={16} stroke={1.75} aria-hidden />
                  </button>
                )}
              </>
            ) : (
              <em className="flex-none text-xs text-secondary not-italic">
                {ACCESS_LABELS[access]}
              </em>
            )}
          </li>
        ))}
      </ul>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-between gap-2">
        <Button
          variant="toolbar"
          disabled={pending}
          onClick={() => void leave()}
        >
          Leave this team folder
        </Button>
        <Button variant="toolbarAction" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
