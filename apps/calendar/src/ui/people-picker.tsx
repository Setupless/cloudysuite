import type { CalendarRole } from "@cloudysuite/access";
import { Avatar, Notice, Working } from "@cloudysuite/ui";
import { IconMail } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { parseEmailAddress } from "../email-address";
import { peopleChoicesQuery } from "../queries";
import type { EmailAddress, Person } from "../types";

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

// Anyone can be invited by address, from the event dialog. Refused says why not, while
// emails can't go from the organiser's address.
export type AddressChoice = {
  onAdd: (address: EmailAddress) => void;
  refused: string | null;
};

export function PeoplePicker({
  label,
  skip,
  adding,
  disabled,
  onAdd,
  addresses,
  children,
}: {
  label: string;
  // People and addresses already chosen, who don't need offering again.
  skip: ReadonlySet<string>;
  // Who's being added, named while the list catches up.
  adding: string | null;
  disabled: boolean;
  onAdd: (person: Person) => Promise<void>;
  addresses?: AddressChoice;
  // More choices beside the box, such as what the person can do.
  children?: ReactNode;
}) {
  const choices = useQuery(peopleChoicesQuery());
  const [text, setText] = useState("");
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
  // A colleague's own address finds the colleague instead.
  const address = addresses && parseEmailAddress(wanted);
  const offered =
    address &&
    !skip.has(address) &&
    !(choices.data ?? []).some((person) => person.email === address)
      ? address
      : null;
  const unfinished = addresses && !address && wanted.includes("@");

  async function add(person: Person) {
    // Cleared now, so the list doesn't offer the person being added again. A clicked
    // choice leaves the list with it, so focus goes back to the box.
    const typed = text;
    setText("");
    setError(null);
    input.current?.focus();
    refocus.current = true;
    try {
      await onAdd(person);
    } catch (failure) {
      setText(typed);
      setError((failure as Error).message);
    }
  }

  function addAddress(chosen: EmailAddress) {
    setText("");
    setError(null);
    input.current?.focus();
    addresses?.onAdd(chosen);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input
          ref={input}
          type="search"
          value={text}
          aria-label={label}
          aria-controls={listId}
          placeholder={
            addresses && !addresses.refused
              ? "Add a person or an email address"
              : "Add a person"
          }
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          // Enter picks the first match, rather than sending a form around the box. An
          // Enter that ends typing with an input method only confirms the text.
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              wanted === ""
            ) {
              return;
            }
            event.preventDefault();
            const [first] = people;
            if (first) void add(first);
            else if (offered && !addresses?.refused) addAddress(offered);
          }}
          className="min-w-0 flex-1 rounded border border-line bg-field px-3 py-2 text-sm text-text outline-accent focus-visible:outline-2 disabled:opacity-60"
        />
        {children}
      </div>
      <div id={listId} className="flex max-h-44 flex-col overflow-y-auto">
        {offered && !addresses?.refused && (
          <button
            type="button"
            disabled={disabled}
            className={CHOICE}
            onClick={() => addAddress(offered)}
          >
            <IconMail
              size={16}
              stroke={1.75}
              aria-hidden
              className="flex-none text-secondary"
            />
            <span className="min-w-0 truncate">Invite {offered} by email</span>
          </button>
        )}
        {offered && addresses?.refused && (
          <p className="px-2 py-1.5 text-sm font-normal text-secondary">
            {addresses.refused}
          </p>
        )}
        {unfinished && people.length === 0 && (
          <p className="px-2 py-1.5 text-sm font-normal text-secondary">
            Finish the email address, such as name@example.com.
          </p>
        )}
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
        {wanted !== "" &&
          choices.isSuccess &&
          people.length === 0 &&
          !offered &&
          !unfinished && (
            <p className="px-2 py-1.5 text-sm font-normal text-secondary">
              {addresses
                ? "Nobody by that name. To invite someone outside your organisation, type their email address."
                : "Nobody by that name. Only people in your organisation can be added."}
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
