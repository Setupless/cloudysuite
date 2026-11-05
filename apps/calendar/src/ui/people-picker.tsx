import type { CalendarRole } from "@cloudysuite/access";
import { Avatar, Notice, Working } from "@cloudysuite/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { peopleChoicesQuery } from "../queries";
import type { Person } from "../types";

const CHOICE =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-accent enabled:hover:bg-field focus-visible:outline-2 disabled:cursor-default disabled:opacity-60";
const CHOICES_SHOWN = 8;

// The one being saved stays at full strength next to its spinner.
export const ROLE_SELECT =
  "flex-none rounded border border-line bg-field px-2 py-1.5 text-[13px] text-text outline-accent focus-visible:outline-2 disabled:not-aria-busy:opacity-60";

export const ROLES = [
  { value: "editor", label: "Can edit" },
  { value: "viewer", label: "Can view" },
  { value: "manager", label: "Manager" },
] as const satisfies readonly { value: CalendarRole; label: string }[];

export function PeoplePicker({
  skip,
  adding,
  disabled,
  onAdd,
}: {
  // People already on the calendar, who don't need offering again.
  skip: ReadonlySet<string>;
  // Who's being added, named while the list catches up.
  adding: string | null;
  disabled: boolean;
  onAdd: (person: Person, role: CalendarRole) => Promise<void>;
}) {
  const choices = useQuery(peopleChoicesQuery());
  const [text, setText] = useState("");
  const [role, setRole] = useState<CalendarRole>("editor");
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  // The box is turned off while an add saves, which takes the person's place away.
  const refocus = useRef(false);
  useEffect(() => {
    if (disabled || !refocus.current) return;
    refocus.current = false;
    input.current?.focus();
  }, [disabled]);

  const wanted = text.trim().toLowerCase();
  const people =
    wanted === ""
      ? []
      : (choices.data ?? []).filter(
          (person) =>
            !skip.has(person.id) &&
            (person.name.toLowerCase().includes(wanted) ||
              person.email.toLowerCase().includes(wanted)),
        );

  async function add(person: Person) {
    // Cleared now, so the list doesn't offer the person being added again.
    const typed = text;
    setText("");
    setError(null);
    refocus.current = true;
    try {
      await onAdd(person, role);
    } catch (failure) {
      setText(typed);
      setError((failure as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input
          ref={input}
          type="search"
          value={text}
          aria-label="Add a person"
          aria-controls={listId}
          placeholder="Add a person"
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          className="min-w-0 flex-1 rounded border border-line bg-field px-3 py-2 text-sm text-text outline-accent focus-visible:outline-2 disabled:opacity-60"
        />
        <select
          aria-label="What they can do"
          value={role}
          disabled={disabled}
          onChange={(event) => setRole(event.target.value as CalendarRole)}
          className={ROLE_SELECT}
        >
          {ROLES.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div id={listId} className="flex max-h-44 flex-col overflow-y-auto">
        {people.slice(0, CHOICES_SHOWN).map((person) => (
          <button
            key={person.id}
            type="button"
            disabled={disabled}
            className={CHOICE}
            onClick={() => void add(person)}
          >
            <Avatar person={person} size="small" />
            <span className="min-w-0 truncate">{person.name}</span>
            <span className="ml-auto min-w-0 truncate text-xs text-secondary">
              {person.email}
            </span>
          </button>
        ))}
        {wanted !== "" && choices.isPending && (
          <div className="px-2 py-1.5">
            <Working>Looking for people…</Working>
          </div>
        )}
        {wanted !== "" && choices.isError && (
          <Notice tone="danger">{choices.error.message}</Notice>
        )}
        {wanted !== "" && choices.isSuccess && people.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-secondary">
            Nobody by that name. Only people in your organisation can be added.
          </p>
        )}
      </div>
      {adding !== null && (
        <div className="px-2">
          <Working>Adding {adding}…</Working>
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
