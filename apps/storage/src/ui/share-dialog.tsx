import type { AccessLevel, DriveId } from "@cloudysuite/access";
import {
  Avatar,
  Button,
  Modal,
  Notice,
  Spinner,
  useToast,
} from "@cloudysuite/ui";
import {
  IconCheck,
  IconFolder,
  IconLink,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { setEveryone, shareItem, unshareItem } from "../sharing-functions";
import { accessQuery, call, refreshStorage } from "../queries";
import type { DriveItem } from "../types";
import { LEVEL_SELECT, PeoplePicker } from "./people-picker";

const LEVELS = [
  { value: "view", label: "Can view" },
  { value: "edit", label: "Can edit" },
] as const;

function Choice({
  icon,
  title,
  detail,
  on,
  pending,
  disabled,
  onChoose,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  on: boolean;
  pending: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-busy={pending || undefined}
      disabled={disabled}
      onClick={onChoose}
      className={`flex w-full cursor-pointer items-center gap-2.5 rounded border px-2.5 py-2 text-left outline-accent focus-visible:outline-2 ${on ? "border-accent bg-selected" : "border-line"}`}
    >
      <span className="flex-none text-secondary">{icon}</span>
      <span className="flex min-w-0 flex-col text-sm">
        {title}
        <span className="text-xs text-secondary">{detail}</span>
      </span>
      {pending ? (
        <span className="ml-auto flex-none text-accent">
          <Spinner />
        </span>
      ) : (
        on && (
          <span className="ml-auto flex-none text-accent">
            <IconCheck size={18} stroke={1.75} aria-hidden />
          </span>
        )
      )}
    </button>
  );
}

// A normal address. Opening it needs signing in and access, like any other page here.
export const itemAddress = (driveId: DriveId, item: DriveItem) =>
  `${window.location.origin}${
    item.kind === "folder"
      ? `/drive/${driveId}/${item.id}`
      : `/file/${driveId}/${item.id}`
  }`;

// The change being saved. The level is kept so the menu shows what was picked, not what
// it was, until the saved list comes back.
type Running =
  | { kind: "level"; personId: string; level: AccessLevel }
  | { kind: "remove"; personId: string }
  | { kind: "everyone"; on: boolean }
  | null;

export function ShareDialog({
  driveId,
  item,
  onClose,
}: {
  driveId: DriveId;
  item: DriveItem;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const access = useQuery(accessQuery(driveId, item.id));
  const { data } = access;
  const [error, setError] = useState<string | null>(null);
  const [linkShown, setLinkShown] = useState<string | null>(null);
  const [running, setRunning] = useState<Running>(null);

  const refresh = () => refreshStorage(client);
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
  const runningOn = (personId: string) =>
    running && running.kind !== "everyone" && running.personId === personId
      ? running
      : null;

  async function copyLink() {
    const link = itemAddress(driveId, item);
    try {
      await navigator.clipboard.writeText(link);
      toast({
        message:
          "Link copied. Only people who can open this will get in, after signing in.",
      });
    } catch {
      setLinkShown(link);
    }
  }

  const shares = data?.lines.filter((line) => line.share !== null) ?? [];
  const everyone = data?.everyone ?? null;
  const organisation = data?.organisation ?? "your organisation";

  return (
    <Modal title={`Share ${item.name}`} onClose={onClose} closeButton>
      <PeoplePicker<AccessLevel>
        levels={LEVELS}
        initialLevel="view"
        skip={new Set(shares.map((line) => line.person.id))}
        onAdd={async (audience, level) => {
          const { added } = await call(() =>
            shareItem({
              data: { driveId, itemId: item.id, audience, level },
            }),
          );
          await refresh();
          if (audience.kind === "team") {
            toast({
              message: `Added ${added === 1 ? "1 person" : `${added} people`} from that team folder.`,
            });
          }
        }}
      />
      {shares.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {shares.map(({ person, share }) => {
            const mine = runningOn(person.id);
            return (
              <li key={person.id} className="flex items-center gap-2 text-sm">
                <Avatar person={person} size="small" />
                <span className="mr-auto min-w-0 truncate">{person.name}</span>
                {mine?.kind === "level" && (
                  <span className="flex-none text-secondary">
                    <Spinner size={16} />
                  </span>
                )}
                <select
                  aria-label={`What ${person.name} can do`}
                  value={
                    mine?.kind === "level" ? mine.level : (share ?? "view")
                  }
                  disabled={running !== null}
                  aria-busy={mine?.kind === "level" || undefined}
                  className={LEVEL_SELECT}
                  onChange={(event) => {
                    const level = event.target.value as AccessLevel;
                    void run(
                      { kind: "level", personId: person.id, level },
                      () =>
                        shareItem({
                          data: {
                            driveId,
                            itemId: item.id,
                            audience: { kind: "person", userId: person.id },
                            level,
                          },
                        }),
                    );
                  }}
                >
                  {LEVELS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label={`Remove ${person.name}`}
                  disabled={running !== null}
                  aria-busy={mine?.kind === "remove" || undefined}
                  className="flex-none cursor-pointer rounded p-1 text-secondary outline-accent hover:bg-field focus-visible:outline-2"
                  onClick={() =>
                    void run({ kind: "remove", personId: person.id }, () =>
                      unshareItem({
                        data: { driveId, itemId: item.id, userId: person.id },
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
              </li>
            );
          })}
        </ul>
      )}
      {access.isError ? (
        <Notice tone="danger">{access.error.message}</Notice>
      ) : !data ? (
        <p
          role="status"
          className="flex items-center gap-2 py-2 text-sm text-secondary"
        >
          <Spinner size={16} />
          Checking who can open it…
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label="Who else can open it"
          className="flex flex-col gap-2"
        >
          <Choice
            icon={<IconUsers size={20} stroke={1.75} aria-hidden />}
            title="Only people added here"
            detail={
              data?.isTeam
                ? "People on the team folder it's in can open it too. Nobody else can."
                : "Nobody else can open it."
            }
            on={everyone === null}
            pending={running?.kind === "everyone" && !running.on}
            disabled={running !== null || everyone === "above"}
            onChoose={() =>
              void run({ kind: "everyone", on: false }, () =>
                setEveryone({ data: { driveId, itemId: item.id, on: false } }),
              )
            }
          />
          <Choice
            icon={<IconFolder size={20} stroke={1.75} aria-hidden />}
            title={`Everyone at ${organisation}`}
            detail="Anyone in your organisation with the link can view it. They can't change it."
            on={everyone !== null}
            pending={running?.kind === "everyone" && running.on}
            disabled={running !== null || everyone === "above"}
            onChoose={() =>
              void run({ kind: "everyone", on: true }, () =>
                setEveryone({ data: { driveId, itemId: item.id, on: true } }),
              )
            }
          />
        </div>
      )}
      {everyone === "above" && (
        <p className="text-xs text-secondary">
          A folder this is in is shared with everyone, so this is too. Change it
          on that folder.
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {linkShown && (
        <Notice tone="danger">
          We couldn't copy it for you. Here's the link: {linkShown}
        </Notice>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="toolbar"
          icon={IconLink}
          onClick={() => void copyLink()}
        >
          Copy link
        </Button>
        <Button variant="toolbarAction" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
