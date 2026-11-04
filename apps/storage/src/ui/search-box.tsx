import { Button, HEADER_SEARCH, Modal, Spinner } from "@cloudysuite/ui";
import { IconHelp, IconSearch, IconX } from "@tabler/icons-react";
import { useIsFetching } from "@tanstack/react-query";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { MAX_SEARCH_LENGTH } from "../search-query";

const AFTER_TYPING_MS = 250;

const OPERATORS: [string, string][] = [
  ['"exact words"', "Has these words in this order"],
  ["type:pdf", "Is this kind of file"],
  ["type:folder", "Is a folder"],
  ["owner:priya", "Added by Priya"],
  ["owner:me", "Added by you"],
  ["is:starred", "Has your star"],
  ["after:2026-03-01", "Changed on this day or later"],
  ["before:2026-04-01", "Changed before this day"],
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
        You can combine these, and a result must match all of them. The kinds
        are folder, image, pdf, document, spreadsheet, presentation, video, and
        audio. Search looks at names, not what's inside files, and Trash is left
        out.
      </p>
      <div className="flex justify-end">
        <Button variant="quiet" autoFocus onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

export function SearchBox() {
  const navigate = useNavigate();
  const router = useRouter();
  const { pathname, search } = useLocation();
  const onResults = pathname.replace(/\/$/, "").endsWith("/search");
  const inAddress = onResults ? ((search as { q?: string }).q ?? "") : "";

  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(inAddress);
  const [helpOpen, setHelpOpen] = useState(false);
  const sent = useRef(inAddress);
  const leftAPage = useRef(false);
  const searching = useIsFetching({ queryKey: ["storage", "search"] }) > 0;

  // The address changing by itself is Back, Forward, or opening a result. Text the person
  // is still typing is newer than what was sent, so it stays.
  useEffect(() => {
    if (inAddress === sent.current) return;
    sent.current = inAddress;
    setText(inAddress);
  }, [inAddress]);

  const send = (value: string) => {
    const query = value.trim();
    if (query === sent.current) return;
    sent.current = query;
    if (query !== "") {
      // Only the first search adds a history entry, so Back leaves search in one step.
      if (!onResults) leftAPage.current = true;
      void navigate({
        to: "/storage/search",
        search: { q: query },
        replace: onResults,
      });
    } else if (leftAPage.current) {
      leftAPage.current = false;
      router.history.back();
    } else {
      void navigate({ to: "/storage", replace: true });
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => send(text), AFTER_TYPING_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useHotkey("/", () => input.current?.focus());

  return (
    <>
      <form
        role="search"
        className={HEADER_SEARCH}
        onSubmit={(event) => {
          event.preventDefault();
          send(text);
        }}
      >
        <span className="flex-none text-secondary">
          {searching ? (
            <Spinner size={16} />
          ) : (
            <IconSearch size={16} stroke={1.75} aria-hidden />
          )}
        </span>
        <input
          ref={input}
          type="text"
          enterKeyHint="search"
          maxLength={MAX_SEARCH_LENGTH}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
          }}
          placeholder="Search files and folders"
          aria-label="Search files and folders"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-text outline-none placeholder:text-secondary max-lg:text-base lg:text-sm"
        />
        {text !== "" && (
          <button
            type="button"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              setText("");
              input.current?.focus();
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
      {helpOpen && <SearchHelp onClose={() => setHelpOpen(false)} />}
    </>
  );
}
