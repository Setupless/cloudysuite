import { HEADER_SEARCH, Spinner } from "@cloudysuite/ui";
import { IconSearch, IconX } from "@tabler/icons-react";
import { useIsFetching } from "@tanstack/react-query";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { tasksKeys } from "../queries";
import { MAX_SEARCH_LENGTH } from "../search-query";

const AFTER_TYPING_MS = 250;
const LABEL = "Search tasks and people";

type SearchAddress = { q?: string; board?: string };

// The board a search starts from puts its members first, and the results page keeps it.
function boardOfPage(
  pathname: string,
  search: SearchAddress,
  onResults: boolean,
) {
  if (onResults) return search.board;
  return /\/boards\/([^/]+)\/?$/.exec(pathname)?.[1];
}

export function SearchBox({ ready }: { ready: boolean }) {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const search = location.search as SearchAddress;
  const onResults = location.pathname.replace(/\/$/, "").endsWith("/search");
  const inAddress = onResults ? (search.q ?? "") : "";
  const board = boardOfPage(location.pathname, search, onResults);

  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(inAddress);
  const sent = useRef(inAddress);
  const leftAPage = useRef(false);
  const searching = useIsFetching({ queryKey: tasksKeys.searches }) > 0;

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
        to: "/tasks/search",
        search: board ? { q: query, board } : { q: query },
        replace: onResults,
      });
    } else if (leftAPage.current) {
      leftAPage.current = false;
      router.history.back();
    } else if (board) {
      void navigate({
        to: "/tasks/boards/$boardId",
        params: { boardId: board },
        replace: true,
      });
    } else {
      void navigate({ to: "/tasks", replace: true });
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => send(text), AFTER_TYPING_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useHotkey("/", () => input.current?.focus(), { enabled: ready });

  return (
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
          if (event.key !== "Escape") return;
          // So Esc here doesn't also close the task panel behind it.
          event.stopPropagation();
          event.currentTarget.blur();
        }}
        placeholder={LABEL}
        aria-label={LABEL}
        aria-keyshortcuts="/"
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
    </form>
  );
}
