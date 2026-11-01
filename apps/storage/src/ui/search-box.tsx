import { IconSearch, IconX } from "@tabler/icons-react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { MAX_SEARCH_LENGTH } from "../search-text";

const AFTER_TYPING_MS = 250;

export function SearchBox() {
  const navigate = useNavigate();
  const router = useRouter();
  const { pathname, search } = useLocation();
  const onResults = pathname.replace(/\/$/, "").endsWith("/search");
  const inAddress = onResults ? ((search as { q?: string }).q ?? "") : "";

  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(inAddress);
  const sent = useRef(inAddress);
  const leftAPage = useRef(false);

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
    <form
      role="search"
      className="flex min-w-0 flex-1 items-center gap-2 rounded bg-field pl-2.5 outline-accent has-focus-visible:outline-2 md:max-w-[360px]"
      onSubmit={(event) => {
        event.preventDefault();
        send(text);
      }}
    >
      <IconSearch
        size={16}
        stroke={1.75}
        className="flex-none text-secondary"
        aria-hidden
      />
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
    </form>
  );
}
