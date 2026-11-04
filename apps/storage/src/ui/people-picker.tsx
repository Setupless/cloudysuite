import { Avatar, Notice, Spinner } from "@cloudysuite/ui";
import { IconFolder } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { shareChoicesQuery } from "../queries";
import { teamColour } from "./team-colour";
import type { Audience } from "../wire";

const CHOICE =
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm outline-accent hover:bg-field focus-visible:outline-2";
const CHOICES_SHOWN = 8;

export const LEVEL_SELECT =
  "flex-none rounded border border-line bg-field px-2 py-1.5 text-[13px] text-text outline-accent focus-visible:outline-2";

// What each option adds is decided by the caller. Picking a team adds the people on it now,
// so its line says how many, and the note below says what that means.
export function PeoplePicker<Level extends string>({
  levels,
  initialLevel,
  skip,
  onAdd,
}: {
  levels: readonly { value: Level; label: string }[];
  initialLevel: Level;
  // People already listed, who don't need offering again.
  skip: ReadonlySet<string>;
  onAdd: (audience: Audience, level: Level) => Promise<void>;
}) {
  const choices = useQuery(shareChoicesQuery());
  const { data } = choices;
  const [text, setText] = useState("");
  const [level, setLevel] = useState(initialLevel);
  const [error, setError] = useState<string | null>(null);
  // Who's being added, named while the list catches up.
  const [adding, setAdding] = useState<string | null>(null);
  const listId = useId();

  const wanted = text.trim().toLowerCase();
  const people =
    wanted === ""
      ? []
      : (data?.people ?? []).filter(
          (person) =>
            !skip.has(person.id) &&
            (person.name.toLowerCase().includes(wanted) ||
              person.email.toLowerCase().includes(wanted)),
        );
  const teams =
    wanted === ""
      ? []
      : (data?.teams ?? []).filter((team) =>
          team.name.toLowerCase().includes(wanted),
        );

  async function add(audience: Audience, name: string) {
    // Cleared now, so a next name typed while this one saves isn't wiped when it finishes.
    const typed = text;
    setText("");
    setAdding(name);
    setError(null);
    try {
      await onAdd(audience, level);
    } catch (failure) {
      setText(typed);
      setError((failure as Error).message);
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input
          type="search"
          value={text}
          aria-label="Add a person or a team"
          aria-controls={listId}
          placeholder="Add a person or a team"
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          className="min-w-0 flex-1 rounded border border-line bg-field px-3 py-2 text-sm text-text outline-accent focus-visible:outline-2"
        />
        <select
          aria-label="What they can do"
          value={level}
          onChange={(event) => setLevel(event.target.value as Level)}
          className={LEVEL_SELECT}
        >
          {levels.map(({ value, label }) => (
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
            disabled={adding !== null}
            className={CHOICE}
            onClick={() =>
              void add({ kind: "person", userId: person.id }, person.name)
            }
          >
            <Avatar person={person} size="small" />
            <span className="min-w-0 truncate">{person.name}</span>
            <span className="ml-auto min-w-0 truncate text-xs text-secondary">
              {person.email}
            </span>
          </button>
        ))}
        {teams.slice(0, CHOICES_SHOWN).map((team) => (
          <button
            key={team.id}
            type="button"
            disabled={adding !== null}
            className={CHOICE}
            onClick={() =>
              void add({ kind: "team", driveId: team.id }, team.name)
            }
          >
            <span
              className={`flex size-[22px] flex-none items-center justify-center rounded text-on-avatar ${teamColour(team.colour)}`}
            >
              <IconFolder size={13} stroke={1.75} aria-hidden />
            </span>
            <span className="min-w-0 truncate">{team.name}</span>
            <span className="ml-auto flex-none text-xs text-secondary">
              {team.people === 1 ? "1 person" : `${team.people} people`}
            </span>
          </button>
        ))}
        {wanted !== "" && choices.isPending && (
          <p
            role="status"
            className="flex items-center gap-2 px-2 py-1.5 text-sm text-secondary"
          >
            <Spinner size={16} />
            Looking for people…
          </p>
        )}
        {wanted !== "" &&
          !choices.isPending &&
          people.length === 0 &&
          teams.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-secondary">
              Nobody by that name. Only people in your organisation can be
              added.
            </p>
          )}
      </div>
      {adding !== null && (
        <p
          role="status"
          className="flex items-center gap-2 px-2 text-sm text-secondary"
        >
          <Spinner size={16} />
          Adding {adding}…
        </p>
      )}
      <p className="text-xs text-secondary">
        A team folder adds the people on it right now, one by one. Anyone who
        joins it later isn't added.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
