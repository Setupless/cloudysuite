import { IconAlertCircle, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { flushSync } from "react-dom";
import type { Address, MailboxId } from "../../types";
import { displayName, formatAddress, recipientLabel } from "../../ui/format";
import { isValidAddress, parseAddressList } from "../validate";
import { suggestionsQuery } from "./queries";

const SUGGEST_DELAY_MS = 150;

function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

function Chip({ person, onRemove }: { person: Address; onRemove: () => void }) {
  const valid = isValidAddress(person.address);
  return (
    <li
      title={formatAddress(person)}
      className={`flex max-w-full items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-sm ${valid ? "bg-field" : "bg-sidebar text-danger"}`}
    >
      {!valid && (
        <IconAlertCircle
          size={14}
          stroke={1.75}
          className="flex-none"
          aria-label="This doesn't look like an email address"
        />
      )}
      <span className="min-w-0 truncate">{recipientLabel(person)}</span>
      <button
        type="button"
        aria-label={`Remove ${person.address}`}
        onClick={onRemove}
        className="flex size-5 flex-none cursor-pointer items-center justify-center rounded-full outline-accent hover:bg-line focus-visible:outline-2"
      >
        <IconX size={12} stroke={2} aria-hidden />
      </button>
    </li>
  );
}

export function RecipientField({
  label,
  mailboxId,
  people,
  onChange,
  autoFocus,
}: {
  label: string;
  mailboxId: MailboxId;
  people: Address[];
  onChange: (people: Address[]) => void;
  autoFocus?: boolean;
}) {
  const inputId = useId();
  const listId = useId();
  const [text, setText] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [focused, setFocused] = useState(false);
  const query = useSettled(text.trim());
  const suggestions = useQuery(suggestionsQuery(mailboxId, query));

  const taken = new Set(people.map(({ address }) => address.toLowerCase()));
  const options = (suggestions.data ?? []).filter(
    ({ address }) => !taken.has(address.toLowerCase()),
  );
  const open = focused && text.trim().length > 0 && options.length > 0;

  const addPeople = (added: Address[]) => {
    const seen = new Set(taken);
    const fresh = added.filter(({ address }) => {
      const key = address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length) onChange([...people, ...fresh]);
    setText("");
    setHighlighted(0);
  };
  const commitText = () => {
    if (text.trim()) addPeople(parseAddressList(text));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // These keys belong to the input method while a word is being composed.
    if (event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey) {
      // Send reads the fields next, so what was just typed has to be in them by then.
      if (event.key === "Enter") flushSync(commitText);
      return;
    }
    if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      setHighlighted((highlighted + 1) % options.length);
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      setHighlighted((highlighted - 1 + options.length) % options.length);
    } else if (event.key === "Escape" && open) {
      event.stopPropagation();
      setFocused(false);
    } else if (
      event.key === "Enter" ||
      event.key === "," ||
      event.key === ";"
    ) {
      if (!text.trim()) {
        if (event.key === "Enter") event.preventDefault();
        return;
      }
      event.preventDefault();
      const chosen =
        open && event.key === "Enter" ? options[highlighted] : null;
      if (chosen) addPeople([chosen]);
      else commitText();
    } else if (event.key === "Tab" && open) {
      event.preventDefault();
      addPeople([options[highlighted] ?? options[0]!]);
    } else if (event.key === "Backspace" && !text && people.length > 0) {
      onChange(people.slice(0, -1));
    }
  };

  return (
    <div className="relative flex items-start gap-2 border-b border-line py-1.5">
      <label
        htmlFor={inputId}
        className="w-10 flex-none py-1 text-sm text-secondary"
      >
        {label}
      </label>
      <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {people.map((person) => (
          <Chip
            key={person.address}
            person={person}
            onRemove={() => onChange(people.filter((one) => one !== person))}
          />
        ))}
        <li className="min-w-32 flex-1">
          <input
            id={inputId}
            type="text"
            autoFocus={autoFocus}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open ? `${listId}-${highlighted}` : undefined
            }
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setHighlighted(0);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              commitText();
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (!/[,;\n]/.test(pasted)) return;
              event.preventDefault();
              addPeople(parseAddressList(`${text}${pasted}`));
            }}
            onKeyDown={onKeyDown}
            className="w-full bg-transparent py-1 text-sm text-text outline-none"
          />
        </li>
      </ul>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Suggested people"
          className="absolute top-full right-0 left-12 z-20 max-h-60 overflow-y-auto rounded border border-line bg-panel py-1 shadow-lg"
        >
          {options.map((option, index) => (
            <li
              key={option.address}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              // Before the input's blur, which would otherwise take the typed text.
              onMouseDown={(event) => {
                event.preventDefault();
                addPeople([option]);
              }}
              className={`flex cursor-pointer flex-col px-3 py-1.5 text-sm ${index === highlighted ? "bg-selected" : "hover:bg-field"}`}
            >
              <span className="truncate">{displayName(option)}</span>
              {option.name && (
                <span className="truncate text-xs text-secondary">
                  {option.address}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
