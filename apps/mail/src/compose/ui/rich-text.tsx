import { Button } from "@cloudysuite/ui";
import {
  IconBold,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
} from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

type FormatCommand =
  "bold" | "italic" | "insertUnorderedList" | "insertOrderedList";

const FORMATS: { command: FormatCommand; label: string; icon: Icon }[] = [
  { command: "bold", label: "Bold", icon: IconBold },
  { command: "italic", label: "Italic", icon: IconItalic },
  { command: "insertUnorderedList", label: "Bulleted list", icon: IconList },
  {
    command: "insertOrderedList",
    label: "Numbered list",
    icon: IconListNumbers,
  },
];

// The browser's own editing commands are the one way to format inside contenteditable
// that keeps undo working, and no replacement exists for them yet.
const run = (command: string, value?: string) =>
  document.execCommand(command, false, value);

function linkTarget(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text)
    ? text
    : text.includes("@") && !text.includes("/")
      ? `mailto:${text}`
      : `https://${text}`;
  const url = URL.parse(withScheme);
  return url && ["http:", "https:", "mailto:"].includes(url.protocol)
    ? url.href
    : null;
}

function ToolbarButton({
  icon: ButtonIcon,
  label,
  pressed,
  onPress,
}: {
  icon: Icon;
  label: string;
  pressed?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      // Keeps the selection in the editor, where the command needs it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
      className="flex size-7 flex-none cursor-pointer items-center justify-center rounded text-secondary outline-accent hover:bg-field hover:text-text focus-visible:outline-2"
    >
      <ButtonIcon size={16} stroke={1.75} aria-hidden />
    </button>
  );
}

export function RichText({
  editor,
  initialHtml,
  onInput,
  autoFocus,
}: {
  editor: RefObject<HTMLDivElement | null>;
  // The server's cleaned copy, reduced to the tags the toolbar can make.
  initialHtml: string;
  onInput: () => void;
  autoFocus?: boolean;
}) {
  const [empty, setEmpty] = useState(!initialHtml);
  const savedRange = useRef<Range | null>(null);
  const [linkText, setLinkText] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);

  useLayoutEffect(() => {
    if (!editor.current) return;
    editor.current.innerHTML = initialHtml;
    if (autoFocus) {
      editor.current.focus();
      getSelection()?.selectAllChildren(editor.current);
      getSelection()?.collapseToEnd();
    }
    // Set once: from here on the editor owns its content, or typing would lose the caret.
  }, []);

  const changed = () => {
    setEmpty(
      !editor.current?.textContent && !editor.current?.querySelector("li"),
    );
    onInput();
  };

  const format = (command: FormatCommand) => {
    editor.current?.focus();
    run(command);
    changed();
  };

  const openLink = () => {
    const selection = getSelection();
    savedRange.current =
      selection?.rangeCount && editor.current?.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    setLinkError(false);
    setLinkText("");
  };

  const applyLink = () => {
    const target = linkTarget(linkText ?? "");
    if (!target) {
      setLinkError(true);
      return;
    }
    editor.current?.focus();
    const selection = getSelection();
    if (savedRange.current && selection) {
      selection.removeAllRanges();
      selection.addRange(savedRange.current);
    }
    if (!selection || selection.isCollapsed) {
      run(
        "insertHTML",
        `<a href="${target.replaceAll('"', "%22")}">${target.replaceAll("<", "&lt;")}</a>`,
      );
    } else {
      run("createLink", target);
    }
    setLinkText(null);
    changed();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex flex-wrap items-center gap-0.5 py-1"
        role="toolbar"
        aria-label="Formatting"
      >
        {FORMATS.map(({ command, label, icon }) => (
          <ToolbarButton
            key={command}
            icon={icon}
            label={label}
            onPress={() => format(command)}
          />
        ))}
        <ToolbarButton icon={IconLink} label="Add a link" onPress={openLink} />
      </div>
      {linkText !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded bg-sidebar p-2">
          <input
            type="text"
            autoFocus
            aria-label="Link address"
            placeholder="example.com"
            value={linkText}
            onChange={(event) => {
              setLinkText(event.target.value);
              setLinkError(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setLinkText(null);
                editor.current?.focus();
              }
            }}
            className="min-w-40 flex-1 rounded border border-line bg-field px-2 py-1 text-sm text-text outline-accent focus-visible:outline-2"
          />
          <Button variant="quiet" onClick={applyLink}>
            Add link
          </Button>
          {linkError && (
            <p role="alert" className="w-full text-xs text-danger">
              That doesn't look like a web or email address.
            </p>
          )}
        </div>
      )}
      <div className="relative min-h-40 flex-1">
        {empty && (
          <p
            aria-hidden
            className="pointer-events-none absolute top-2 left-0 text-sm text-secondary"
          >
            Write your message
          </p>
        )}
        <div
          ref={editor}
          role="textbox"
          aria-multiline
          aria-label="Message"
          contentEditable
          suppressContentEditableWarning
          onInput={changed}
          // Pasted markup is a stranger's markup. Only its text comes in.
          onPaste={(event) => {
            event.preventDefault();
            run("insertText", event.clipboardData.getData("text/plain"));
            changed();
          }}
          // Dropped text could carry markup too. Dropped files go to the attachments.
          onDrop={(event) => event.preventDefault()}
          className="h-full min-h-40 py-2 text-sm leading-6 break-words outline-none [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
        />
      </div>
    </div>
  );
}
