import type { UserId } from "@cloudysuite/access";
import { Avatar, Button, Modal, Notice, Working } from "@cloudysuite/ui";
import { IconCheck, IconChevronDown, IconUserPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { colleaguesQuery } from "../queries";
import type { Colleague, Member, Person } from "../types";
import { assigneeChoices, firstNameOf } from "./assignee-choices";
import { FOCUS, PersonAvatar } from "./parts";

// What the person picked. Someone from the rest of the organisation is added to the board
// first, which only a manager can do.
export type AssigneePick =
  | { kind: "nobody" }
  | { kind: "member"; person: Member }
  | { kind: "addAndAssign"; person: Colleague };

type Step =
  | { kind: "closed" }
  // `asked` is someone from the rest of the organisation that a non-manager picked.
  | { kind: "choosing"; typed: string; asked: Colleague | null }
  | {
      kind: "confirming";
      typed: string;
      person: Colleague;
      saving: boolean;
      error: string | null;
    };

const CHOICE = `flex min-h-10 w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-field ${FOCUS}`;
const SECTION = "px-2 pt-3 pb-1 text-xs font-semibold text-secondary";

function Choice({
  chosen,
  onPick,
  children,
}: {
  chosen: boolean;
  onPick: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={chosen}
        className={CHOICE}
        onClick={onPick}
      >
        {children}
        {chosen && (
          <IconCheck
            size={16}
            stroke={2}
            className="ml-auto flex-none text-accent"
            aria-label="Assigned"
          />
        )}
      </button>
    </li>
  );
}

function PersonChoice({
  person,
  me,
  chosen,
  onPick,
}: {
  person: Colleague;
  me: UserId;
  chosen: boolean;
  onPick: () => void;
}) {
  return (
    <Choice chosen={chosen} onPick={onPick}>
      <Avatar person={person} size="small" />
      <span className="min-w-0 truncate" dir="auto">
        {person.name}
        {person.id === me && <span className="text-secondary"> (you)</span>}
      </span>
    </Choice>
  );
}

// The board's members, then everyone else in the organisation. A manager who picks
// someone from the second section is asked before they're added. Anyone else is told
// who can add them.
function PickerDialog({
  step,
  boardName,
  canAdd,
  members,
  me,
  assignee,
  onStep,
  onPick,
  onClose,
}: {
  step: Exclude<Step, { kind: "closed" }>;
  boardName: string;
  canAdd: boolean;
  members: readonly Member[];
  me: UserId;
  assignee: Person | null;
  onStep: (step: Step) => void;
  onPick: (pick: AssigneePick) => Promise<void>;
  onClose: () => void;
}) {
  const colleagues = useQuery(colleaguesQuery());
  const { onBoard, others } = assigneeChoices(
    step.typed,
    members,
    colleagues.data ?? [],
  );

  if (step.kind === "confirming") {
    const first = firstNameOf(step.person.name);
    const confirm = async () => {
      onStep({ ...step, saving: true, error: null });
      try {
        await onPick({ kind: "addAndAssign", person: step.person });
        onClose();
      } catch (failure) {
        onStep({ ...step, saving: false, error: (failure as Error).message });
      }
    };
    return (
      <Modal
        title={`Add ${step.person.name} to ${boardName}?`}
        onClose={onClose}
        busy={step.saving}
      >
        <p className="text-sm text-secondary">
          {first} isn't on {boardName} yet. Adding them lets them open this
          board and its tasks.
        </p>
        {step.error && <Notice tone="danger">{step.error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button
            variant="toolbar"
            disabled={step.saving}
            onClick={() =>
              onStep({ kind: "choosing", typed: step.typed, asked: null })
            }
          >
            Back
          </Button>
          <Button
            variant="toolbarAction"
            icon={IconUserPlus}
            pending={step.saving}
            onClick={() => void confirm()}
          >
            Add and assign
          </Button>
        </div>
      </Modal>
    );
  }

  const pick = (choice: AssigneePick) => {
    onClose();
    void onPick(choice);
  };
  const pickOther = (person: Colleague) =>
    canAdd
      ? onStep({
          kind: "confirming",
          typed: step.typed,
          person,
          saving: false,
          error: null,
        })
      : onStep({ ...step, asked: person });
  const first = onBoard[0];
  const firstOther = others[0];
  const nothing = onBoard.length === 0 && others.length === 0;

  return (
    <Modal title="Assign to" onClose={onClose} closeButton>
      <input
        type="search"
        autoFocus
        autoComplete="off"
        aria-label="Search people"
        placeholder="Search people"
        value={step.typed}
        className={`rounded border border-line bg-field px-3 py-2 text-sm text-text ${FOCUS}`}
        onChange={(event) =>
          onStep({ kind: "choosing", typed: event.target.value, asked: null })
        }
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (step.typed.trim() === "") return;
          if (first) pick({ kind: "member", person: first });
          else if (firstOther) pickOther(firstOther);
        }}
      />
      {step.asked && (
        <Notice tone="info">
          Ask a {boardName} manager to add {firstNameOf(step.asked.name)}.
        </Notice>
      )}
      <div className="-mx-2 flex max-h-[min(24rem,60dvh)] flex-col overflow-y-auto">
        {step.typed.trim() === "" && (
          <ul>
            <Choice
              chosen={assignee === null}
              onPick={() => pick({ kind: "nobody" })}
            >
              <span className="flex size-6 flex-none items-center justify-center rounded-full border border-dashed border-line" />
              Nobody yet
            </Choice>
          </ul>
        )}
        {onBoard.length > 0 && (
          <>
            <h3 className={SECTION}>On {boardName}</h3>
            <ul>
              {onBoard.map((person) => (
                <PersonChoice
                  key={person.id}
                  person={person}
                  me={me}
                  chosen={assignee?.id === person.id}
                  onPick={() => pick({ kind: "member", person })}
                />
              ))}
            </ul>
          </>
        )}
        {others.length > 0 && (
          <>
            <h3 className={SECTION}>Others in your organisation</h3>
            <ul>
              {others.map((person) => (
                <PersonChoice
                  key={person.id}
                  person={person}
                  me={me}
                  chosen={false}
                  onPick={() => pickOther(person)}
                />
              ))}
            </ul>
          </>
        )}
        {colleagues.isPending && (
          <div className="px-2 py-1.5">
            <Working>Looking for people…</Working>
          </div>
        )}
        {colleagues.isError && (
          <Notice tone="danger">{colleagues.error.message}</Notice>
        )}
        {nothing && colleagues.isSuccess && (
          <p className="px-2 py-1.5 text-sm text-secondary">
            Nobody by that name. Try part of their first or last name.
          </p>
        )}
      </div>
    </Modal>
  );
}

// Who a task is assigned to, as a button that opens the picker. `gone` says the person
// it's assigned to has left the board, so the team knows to reassign it.
export function AssigneePicker({
  boardName,
  canAdd,
  members,
  me,
  assignee,
  gone,
  compact = false,
  onPick,
}: {
  boardName: string;
  canAdd: boolean;
  members: readonly Member[];
  me: UserId;
  assignee: Person | null;
  gone: boolean;
  // A small chip, as in the new task row.
  compact?: boolean;
  // Throws, with the words to show, when an add and assign can't be made.
  onPick: (pick: AssigneePick) => Promise<void>;
}) {
  const [step, setStep] = useState<Step>({ kind: "closed" });
  const email = members.find((member) => member.id === assignee?.id)?.email;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`Assigned to: ${assignee?.name ?? "Nobody yet"}. Change`}
        className={
          compact
            ? `flex h-7 max-w-48 cursor-pointer items-center gap-1.5 rounded border border-line bg-field px-2 text-xs text-text ${FOCUS}`
            : `flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-field ${FOCUS}`
        }
        onClick={() => setStep({ kind: "choosing", typed: "", asked: null })}
      >
        {assignee && <PersonAvatar person={assignee} email={email} />}
        <span className="flex min-w-0 flex-col">
          <span
            dir="auto"
            className={`truncate ${assignee ? "" : "text-secondary"}`}
          >
            {assignee?.name ?? (compact ? "Assign" : "Nobody yet")}
          </span>
          {gone && !compact && (
            <span className="truncate text-xs text-secondary">
              No longer on {boardName}
            </span>
          )}
        </span>
        <IconChevronDown
          size={14}
          stroke={1.75}
          className="ml-auto flex-none text-secondary"
          aria-hidden
        />
      </button>
      {step.kind !== "closed" && (
        <PickerDialog
          step={step}
          boardName={boardName}
          canAdd={canAdd}
          members={members}
          me={me}
          assignee={assignee}
          onStep={setStep}
          onPick={onPick}
          onClose={() => setStep({ kind: "closed" })}
        />
      )}
    </>
  );
}
