import { Button, Modal } from "@cloudysuite/ui";
import { IconHelp, IconSearch, IconX } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useState } from "react";
import { MAX_SEARCH_LENGTH } from "../search/query";
import type { MailboxId } from "../types";

const OPERATORS: [string, string][] = [
  ["from:priya", "Sent by Priya"],
  ["to:sam", "Sent to or copied to Sam"],
  ["subject:invoice", "Has this word in the subject"],
  ['"exact words"', "Has these words in this order"],
  ["has:attachment", "Has a file attached"],
  ["is:unread", "Not read yet"],
  ["is:starred", "Has a star"],
  ["in:archive", "In one folder, including Spam or Trash"],
  ['label:"To do"', "Has this label"],
  ["after:2026-03-01", "Arrived on this day or later"],
  ["before:2026-04-01", "Arrived before this day"],
];

function SearchHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Ways to search" onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 text-sm">
        {OPERATORS.map(([example, meaning]) => (
          <div key={example} className="col-span-2 grid grid-cols-subgrid">
            <dt>
              <code className="rounded bg-field px-1.5 py-0.5 font-mono text-xs">
                {example}
              </code>
            </dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-secondary">
        You can combine these, and a message must match all of them. Spam and
        Trash are left out unless you ask for them. Search reads the first 1 MB
        of a message's text, and it doesn't look inside attached files.
      </p>
      <div className="flex justify-end">
        <Button variant="quiet" autoFocus onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

export function SearchBox({
  mailboxId,
  initial,
  inputRef,
}: {
  mailboxId: MailboxId;
  initial: string;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState(initial);
  const [helpOpen, setHelpOpen] = useState(false);
  const tooLong = text.length > MAX_SEARCH_LENGTH;

  const leaveSearch = () =>
    void navigate({
      to: "/mail/$mailboxId/$view",
      params: { mailboxId, view: "inbox" },
    });

  return (
    <div className="flex-none px-3 pt-3">
      <form
        role="search"
        className="flex items-center gap-1 rounded border border-line bg-field pl-2.5 outline-accent has-focus-visible:outline-2"
        onSubmit={(event) => {
          event.preventDefault();
          const query = text.trim();
          if (tooLong) return;
          if (query === "") {
            if (initial !== "") leaveSearch();
            return;
          }
          void navigate({
            to: "/mail/$mailboxId/$view",
            params: { mailboxId, view: "search" },
            search: { q: query },
          });
        }}
      >
        <IconSearch
          size={16}
          stroke={1.75}
          className="flex-none text-secondary"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="text"
          enterKeyHint="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
          }}
          placeholder="Search mail"
          aria-label="Search mail"
          aria-invalid={tooLong}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-text outline-none placeholder:text-secondary max-lg:text-base lg:text-sm"
        />
        {text !== "" && (
          <button
            type="button"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              setText("");
              if (initial !== "") leaveSearch();
              else inputRef.current?.focus();
            }}
            className="flex size-7 flex-none cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:text-text focus-visible:outline-2"
          >
            <IconX size={16} stroke={1.75} aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label="Ways to search"
          title="Ways to search"
          onClick={() => setHelpOpen(true)}
          className="flex size-7 flex-none cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:text-text focus-visible:outline-2"
        >
          <IconHelp size={16} stroke={1.75} aria-hidden />
        </button>
      </form>
      {tooLong && text !== initial && (
        <p role="alert" className="px-1 pt-1.5 text-xs text-danger">
          That search is too long. Keep it under {MAX_SEARCH_LENGTH} characters.
        </p>
      )}
      {helpOpen && <SearchHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
