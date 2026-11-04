import { Button, Modal, Spinner } from "@cloudysuite/ui";
import { IconPlus } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cleanLabelName } from "../labels/store";
import type { LabelId, MailboxId, ThreadId } from "../types";
import type { LabelCommands } from "./label-commands";
import { useLabels } from "./label-chip";

export function LabelPicker({
  mailboxId,
  threadId,
  applied,
  commands,
  onClose,
}: {
  mailboxId: MailboxId;
  threadId: ThreadId;
  applied: readonly LabelId[];
  commands: LabelCommands;
  onClose: () => void;
}) {
  const labels = useLabels(mailboxId);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const filterField = useRef<HTMLInputElement>(null);
  const wanted = filter.trim().toLowerCase();
  const matching = labels.filter((label) =>
    label.name.toLowerCase().includes(wanted),
  );
  const newName = cleanLabelName(filter);
  const canCreate =
    newName !== null &&
    !labels.some((label) => label.name.toLowerCase() === newName.toLowerCase());

  const toggle = (labelId: LabelId) =>
    commands.setApplied(threadId, labelId, !applied.includes(labelId));

  const createAndApply = async () => {
    if (!newName || creating) return;
    setCreating(true);
    const created = await commands.create(newName);
    // The box drops focus while it is disabled, so it can only take it back once enabled.
    flushSync(() => setCreating(false));
    filterField.current?.focus();
    if (!created) return;
    commands.setApplied(threadId, created.id, true);
    setFilter("");
  };

  return (
    <Modal title="Labels" onClose={onClose}>
      <input
        ref={filterField}
        autoFocus
        type="text"
        value={filter}
        disabled={creating}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const first = matching[0];
          if (first) toggle(first.id);
          else if (canCreate) void createAndApply();
        }}
        placeholder={labels.length > 0 ? "Find or create a label" : "New label"}
        aria-label="Find or create a label"
        className="w-full rounded border border-line bg-field px-3 py-2 text-text outline-accent placeholder:text-secondary focus-visible:outline-2 disabled:opacity-60 max-lg:text-base lg:text-sm"
      />
      {matching.length > 0 && (
        <ul className="flex max-h-64 flex-col overflow-y-auto">
          {matching.map((label) => (
            <li key={label.id}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded px-1.5 py-1.5 text-sm hover:bg-field">
                <input
                  type="checkbox"
                  checked={applied.includes(label.id)}
                  onChange={() => toggle(label.id)}
                  className="size-4 flex-none accent-accent"
                />
                <span className="min-w-0 flex-1 truncate">{label.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {labels.length === 0 && wanted === "" && (
        <p className="text-sm text-secondary">
          You have no labels yet. Type a name to create your first one.
        </p>
      )}
      {canCreate && (
        <button
          type="button"
          onClick={() => void createAndApply()}
          disabled={creating}
          aria-busy={creating || undefined}
          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm text-accent outline-accent hover:bg-field focus-visible:outline-2 disabled:cursor-default aria-busy:cursor-progress"
        >
          {creating ? (
            <span className="flex flex-none">
              <Spinner size={16} />
            </span>
          ) : (
            <IconPlus
              size={16}
              stroke={1.75}
              className="flex-none"
              aria-hidden
            />
          )}
          <span className="min-w-0 truncate">Create "{newName}"</span>
        </button>
      )}
      <div className="flex justify-end">
        <Button variant="quiet" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
