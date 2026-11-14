import type { BoardId, UserId } from "@cloudysuite/access";
import { Button, Modal, Notice } from "@cloudysuite/ui";
import { IconCheck, IconLock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { boardsQuery, settingsQuery } from "../queries";
import type { BoardOfTask, MoveTarget, Person, Task } from "../types";
import { BoardSwatch, canEditWith, FOCUS } from "./parts";

type Choice = { target: MoveTarget; name: string; colour: number | null };

const PRIVATE: Choice = {
  target: "private",
  name: "Your private tasks",
  colour: null,
};

function nobodyNote(
  assignee: Person,
  choice: Choice,
  onBoard: boolean,
  me: UserId,
): string | null {
  if (choice.target === "private") {
    return "Only you see your private tasks, so the task will have nobody assigned.";
  }
  if (onBoard) return null;
  const who = assignee.id === me ? "You aren't" : `${assignee.name} isn't`;
  return `${who} on ${choice.name}, so the task will have nobody assigned.`;
}

export function MoveDialog({
  task,
  board,
  me,
  onMove,
  onClose,
}: {
  task: Task;
  board: BoardOfTask;
  me: UserId;
  // Resolves once moved or on its way, and throws with the words to show if refused.
  onMove: (target: MoveTarget) => Promise<void>;
  onClose: () => void;
}) {
  const boards = useQuery(boardsQuery());
  const choices: Choice[] = [
    ...(board.kind === "personal" ? [] : [PRIVATE]),
    ...(boards.data ?? [])
      .filter((entry) => canEditWith(entry.role) && entry.id !== board.id)
      .map((entry) => ({
        target: entry.id,
        name: entry.name,
        colour: entry.colour,
      })),
  ];
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const toTeam =
    chosen && chosen.target !== "private" ? (chosen.target as BoardId) : null;
  // Only needed to say whether the assignee goes along.
  const members = useQuery({
    ...settingsQuery(toTeam ?? ("" as BoardId)),
    enabled: toTeam !== null && task.assignee !== null,
  });
  const membersKnown =
    toTeam === null || task.assignee === null || members.data;
  const note =
    chosen && task.assignee && membersKnown
      ? nobodyNote(
          task.assignee,
          chosen,
          members.data?.members.some(
            (member) => member.id === task.assignee?.id,
          ) ?? false,
          me,
        )
      : null;

  async function move() {
    if (!chosen) return;
    setPending(true);
    setError(null);
    try {
      await onMove(chosen.target);
      onClose();
    } catch (failure) {
      setError((failure as Error).message);
      setPending(false);
    }
  }

  return (
    <Modal title={`Move "${task.title}"`} onClose={onClose} busy={pending}>
      {boards.isPending ? (
        <p className="text-sm text-secondary">Loading your boards…</p>
      ) : choices.length === 0 ? (
        <p className="text-sm text-secondary">
          There's no other board you can add tasks to. Make a team board, or ask
          a board's manager for Can edit.
        </p>
      ) : (
        <div
          role="radiogroup"
          aria-label="Move to"
          className="-mx-1 flex max-h-72 flex-col overflow-y-auto"
        >
          {choices.map((choice) => {
            const selected = chosen?.target === choice.target;
            return (
              <button
                key={choice.target}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={pending}
                className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded px-2 text-left text-sm disabled:cursor-default ${selected ? "bg-selected" : "enabled:hover:bg-field"} ${FOCUS}`}
                onClick={() => {
                  setChosen(choice);
                  setError(null);
                }}
              >
                <span className="flex size-[18px] flex-none items-center justify-center text-secondary">
                  {choice.colour === null ? (
                    <IconLock size={16} stroke={1.75} aria-hidden />
                  ) : (
                    <BoardSwatch colour={choice.colour} />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {choice.name}
                </span>
                {selected && (
                  <IconCheck
                    size={16}
                    stroke={2}
                    className="flex-none text-accent"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
      {note && <Notice tone="info">{note}</Notice>}
      {members.error && <Notice tone="danger">{members.error.message}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end gap-2">
        <Button variant="toolbar" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="toolbarAction"
          disabled={!chosen || !membersKnown}
          pending={pending}
          onClick={() => void move()}
        >
          Move
        </Button>
      </div>
    </Modal>
  );
}
