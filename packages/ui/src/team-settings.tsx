import { IconCheck, IconX } from "@tabler/icons-react";
import { type FormEvent, useState } from "react";
import { Avatar, Button, Spinner, TextField } from "./index";

// What a person can do on a team calendar or a team board.
export type TeamRole = "manager" | "editor" | "viewer";

export const ROLE_CHOICES = [
  { value: "editor", label: "Can edit" },
  { value: "viewer", label: "Can view" },
  { value: "manager", label: "Manager" },
] as const satisfies readonly { value: TeamRole; label: string }[];

export const ROLE_LABELS: Record<TeamRole, string> = {
  editor: "Can edit",
  viewer: "Can view",
  manager: "Manager",
};

// The one being saved stays at full strength next to its spinner.
export const ROLE_SELECT =
  "flex-none rounded border border-line bg-field px-2 py-1.5 text-[13px] text-text outline-accent focus-visible:outline-2 disabled:not-aria-busy:opacity-60";

export const SETTINGS_HEADING = "text-sm font-medium";

// Written out in full, because Tailwind only makes the classes it finds in the source.
const FILLS = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
];

export const teamColourFill = (colour: number) =>
  FILLS[(colour - 1) % FILLS.length];

// In the order of the avatar roles, so colour n is TEAM_COLOUR_NAMES[n - 1].
export const TEAM_COLOUR_NAMES = [
  "Blue",
  "Purple",
  "Green",
  "Brown",
  "Slate",
  "Red",
] as const;

const REMOVE_BUTTON =
  "flex-none cursor-pointer rounded p-1 text-secondary outline-accent enabled:hover:bg-field focus-visible:outline-2 disabled:cursor-default disabled:not-aria-busy:opacity-60 aria-busy:cursor-progress";

export function ColourChoice({
  colour,
  disabled,
  onChoose,
}: {
  colour: number;
  disabled: boolean;
  onChoose: (colour: number) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className={`${SETTINGS_HEADING} mb-1.5`}>Colour</legend>
      <div className="flex gap-2.5">
        {TEAM_COLOUR_NAMES.map((name, index) => {
          const value = index + 1;
          const chosen = value === colour;
          return (
            <label key={name} className="cursor-pointer">
              <input
                type="radio"
                name="colour"
                className="peer sr-only"
                checked={chosen}
                disabled={disabled}
                aria-label={name}
                onChange={() => onChoose(value)}
              />
              <span
                aria-hidden
                className={`flex size-8 items-center justify-center rounded-full text-on-avatar ring-offset-2 ring-offset-panel outline-accent peer-checked:ring-2 peer-checked:ring-text peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-disabled:cursor-default ${teamColourFill(value)}`}
              >
                {chosen && <IconCheck size={16} stroke={3} />}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function RenameForm({
  name,
  disabled,
  pending,
  onRename,
}: {
  name: string;
  disabled: boolean;
  pending: boolean;
  onRename: (name: string) => void;
}) {
  const [text, setText] = useState(name);
  const changed = text.trim() !== "" && text.trim() !== name;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (changed) onRename(text.trim());
  }
  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <TextField
        label="Name"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
      />
      <span className="flex-none">
        <Button
          type="submit"
          variant="secondary"
          disabled={disabled || !changed}
          pending={pending}
        >
          Rename
        </Button>
      </span>
    </form>
  );
}

// What's being saved for this one person, so its control shows what was picked.
export type MemberSaving =
  { kind: "role"; role: TeamRole } | { kind: "remove" } | null;

// One person on a team. A manager sees what they can do as a choice, with Remove for
// anyone but themselves, and everyone else sees it as words.
export function MemberLine({
  person,
  role,
  isMe,
  canManage,
  busy,
  saving,
  onRole,
  onRemove,
}: {
  person: { name: string; email: string };
  role: TeamRole;
  isMe: boolean;
  canManage: boolean;
  busy: boolean;
  saving: MemberSaving;
  onRole: (role: TeamRole) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <Avatar person={person} size="small" />
      <span className="mr-auto min-w-0 truncate">
        {person.name}
        {isMe && <span className="text-secondary"> (you)</span>}
      </span>
      {canManage ? (
        <>
          {saving?.kind === "role" && (
            <span className="flex-none text-secondary">
              <Spinner size={16} />
            </span>
          )}
          <select
            aria-label={`What ${person.name} can do`}
            value={saving?.kind === "role" ? saving.role : role}
            disabled={busy}
            aria-busy={saving?.kind === "role" || undefined}
            className={ROLE_SELECT}
            onChange={(event) => onRole(event.target.value as TeamRole)}
          >
            {ROLE_CHOICES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {!isMe && (
            <button
              type="button"
              aria-label={`Remove ${person.name}`}
              disabled={busy}
              aria-busy={saving?.kind === "remove" || undefined}
              className={REMOVE_BUTTON}
              onClick={onRemove}
            >
              {saving?.kind === "remove" ? (
                <Spinner size={16} />
              ) : (
                <IconX size={16} stroke={1.75} aria-hidden />
              )}
            </button>
          )}
        </>
      ) : (
        <em className="flex-none text-xs text-secondary not-italic">
          {ROLE_LABELS[role]}
        </em>
      )}
    </li>
  );
}
