import type { BoardId, BoardRole, UserId } from "@cloudysuite/access";
import { Button, linkify } from "@cloudysuite/ui";
import { IconPencil, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  type BoardOfTask,
  type ChecklistItem,
  type ChecklistItemId,
  LIMITS,
  type Member,
  type PlainDate,
  parsePlainDate,
  type Task,
  type TaskStatus,
} from "../types";
import { type Editing, isEditing, type ListState } from "./list-state";
import { FIELD } from "./new-task-row";
import { BoardName, FOCUS, PersonAvatar, TickButton } from "./parts";
import type { useTaskChanges } from "./use-task-changes";

export const canEditWith = (role: BoardRole) =>
  role === "manager" || role === "editor";

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  doing: "Doing",
  done: "Done",
};

const LABEL = "w-24 flex-none pt-1 text-secondary";

type Changes = ReturnType<typeof useTaskChanges>;

// Typed into in place. Enter or leaving the box saves, and Esc puts it back.
function InPlaceText({
  value,
  label,
  multiline = false,
  maxLength,
  className,
  onSave,
  onDone,
}: {
  value: string;
  label: string;
  multiline?: boolean;
  maxLength: number;
  className: string;
  onSave: (text: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (save && draft !== value) onSave(draft);
    onDone();
  };
  const keys = (key: KeyboardEvent) => {
    if (key.key === "Escape") {
      key.stopPropagation();
      finish(false);
    } else if (key.key === "Enter" && !(multiline && key.shiftKey)) {
      if (multiline) return;
      key.preventDefault();
      finish(true);
    }
  };
  const shared = {
    autoFocus: true,
    "aria-label": label,
    value: draft,
    maxLength,
    dir: "auto",
    className: `w-full rounded border border-line bg-field px-2 py-1.5 text-text ${FOCUS} ${className}`,
    onKeyDown: keys,
    onBlur: () => finish(true),
  };
  return multiline ? (
    <textarea
      {...shared}
      rows={5}
      onChange={(event) => setDraft(event.target.value)}
    />
  ) : (
    <input {...shared} onChange={(event) => setDraft(event.target.value)} />
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[13px]">
      <span className={LABEL}>{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {children}
      </div>
    </div>
  );
}

function StatusControl({
  status,
  disabled,
  onChange,
}: {
  status: TaskStatus;
  disabled: boolean;
  onChange: (status: TaskStatus) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Status"
      className="flex w-fit rounded bg-field p-0.5 text-[13px]"
    >
      {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={status === option}
          disabled={disabled}
          className={`cursor-pointer rounded-[7px] px-3 py-1 disabled:cursor-default ${status === option ? "bg-panel font-semibold shadow-sm" : "text-secondary enabled:hover:text-text"} ${FOCUS}`}
          onClick={() => onChange(option)}
        >
          {STATUS_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

function NotesText({ notes }: { notes: string }) {
  return linkify(notes).map((segment, index) =>
    segment.kind === "link" && segment.href.startsWith("https://") ? (
      <a
        key={index}
        href={segment.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`break-all text-accent underline ${FOCUS}`}
      >
        {segment.text}
      </a>
    ) : (
      segment.text
    ),
  );
}

function ChecklistRow({
  item,
  canEdit,
  editing,
  onEdit,
  onDone,
  onToggle,
  onRename,
  onRemove,
}: {
  item: ChecklistItem;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onToggle: () => void;
  onRename: (text: string) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-1 text-[13px]">
      <TickButton
        done={item.done}
        title={item.text}
        disabled={!canEdit}
        onTick={onToggle}
      />
      {editing ? (
        <InPlaceText
          value={item.text}
          label="Checklist item"
          maxLength={LIMITS.checklistItem * 4}
          className="text-[13px]"
          onSave={onRename}
          onDone={onDone}
        />
      ) : (
        <button
          type="button"
          disabled={!canEdit}
          dir="auto"
          className={`min-h-8 min-w-0 flex-1 cursor-pointer rounded px-1 text-left break-words enabled:hover:bg-field disabled:cursor-default ${item.done ? "text-secondary line-through" : ""} ${FOCUS}`}
          onClick={onEdit}
        >
          {item.text}
        </button>
      )}
      {canEdit && !editing && (
        <button
          type="button"
          aria-label={`Remove ${item.text}`}
          className={`flex size-8 flex-none cursor-pointer items-center justify-center rounded text-secondary hover:bg-field hover:text-text ${FOCUS}`}
          onClick={onRemove}
        >
          <IconX size={14} stroke={1.75} aria-hidden />
        </button>
      )}
    </li>
  );
}

function Checklist({
  task,
  boardId,
  canEdit,
  state,
  onEdit,
  onDone,
  changes,
}: {
  task: Task;
  boardId: BoardId;
  canEdit: boolean;
  state: ListState;
  onEdit: (field: Editing) => void;
  onDone: () => void;
  changes: Changes;
}) {
  const [adding, setAdding] = useState("");
  const done = task.checklist.filter((item) => item.done).length;
  const send = (change: Parameters<Changes["send"]>[1]) =>
    void changes.send(boardId, change);
  const full = task.checklist.length >= LIMITS.checklistItems;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[13px] font-semibold">
        Checklist
        {task.checklist.length > 0 && (
          <span className="ml-1.5 font-normal text-secondary">
            {done} of {task.checklist.length}
          </span>
        )}
      </h3>
      <ul className="flex flex-col">
        {task.checklist.map((item) => (
          <ChecklistRow
            key={item.id}
            item={item}
            canEdit={canEdit}
            editing={isEditing(state, { item: item.id })}
            onEdit={() => onEdit({ item: item.id })}
            onDone={onDone}
            onToggle={() =>
              send({
                kind: "toggleItem",
                id: task.id,
                itemId: item.id,
                done: !item.done,
              })
            }
            onRename={(text) =>
              send({ kind: "renameItem", id: task.id, itemId: item.id, text })
            }
            onRemove={() =>
              send({ kind: "removeItem", id: task.id, itemId: item.id })
            }
          />
        ))}
      </ul>
      {canEdit && !full && (
        <form
          className="flex items-center gap-2 pl-1.5 text-[13px]"
          onSubmit={(event) => {
            event.preventDefault();
            if (adding.trim() === "") return;
            send({
              kind: "addItem",
              id: task.id,
              itemId: crypto.randomUUID() as ChecklistItemId,
              text: adding,
            });
            setAdding("");
          }}
        >
          <IconPlus
            size={16}
            stroke={1.75}
            className="flex-none text-secondary"
            aria-hidden
          />
          <input
            aria-label="Add a checklist item"
            placeholder="Add an item"
            value={adding}
            maxLength={LIMITS.checklistItem * 4}
            className={`min-h-8 min-w-0 flex-1 rounded bg-transparent px-1 text-text placeholder:text-secondary ${FOCUS}`}
            onChange={(event) => setAdding(event.target.value)}
          />
        </form>
      )}
      {!canEdit && task.checklist.length === 0 && (
        <p className="text-[13px] text-secondary">No checklist.</p>
      )}
    </section>
  );
}

export function TaskPanel({
  task,
  board,
  role,
  me,
  members,
  state,
  changes,
  onEdit,
  onDoneEditing,
  onClose,
}: {
  task: Task;
  board: BoardOfTask;
  role: BoardRole;
  me: UserId;
  // On a team board, the people a task can be given to.
  members: Member[] | undefined;
  state: ListState;
  changes: Changes;
  onEdit: (field: Editing) => void;
  onDoneEditing: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const canEdit = canEditWith(role);
  // Can view may still tick off their own work.
  const canSetStatus = canEdit || task.assignee?.id === me;
  const send = (change: Parameters<Changes["send"]>[1]) =>
    void changes.send(board.id, change);
  // On a phone the panel covers the list, so focus moves here from the row.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, [task.id]);

  const assignees = members ?? [];
  const assigneeGone =
    task.assignee !== null &&
    !assignees.some((member) => member.id === task.assignee?.id);

  return (
    <aside
      ref={panel}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`w-[300px] flex-none border-l border-line bg-panel max-sm:fixed max-sm:inset-0 max-sm:z-20 max-sm:w-auto ${FOCUS}`}
    >
      <div className="flex flex-col gap-4 overflow-y-auto p-4 max-sm:h-full sm:sticky sm:top-0 sm:max-h-dvh">
        <div className="flex items-start gap-1.5">
          <TickButton
            done={task.status === "done"}
            title={task.title}
            disabled={!canSetStatus}
            onTick={() => void changes.tick(board.id, task)}
          />
          <h2
            id={titleId}
            className="min-w-0 flex-1 text-[17px] font-semibold break-words"
          >
            {isEditing(state, "title") ? (
              <InPlaceText
                value={task.title}
                label="Title"
                maxLength={LIMITS.title * 4}
                className="text-[17px] font-semibold"
                onSave={(title) => send({ kind: "rename", id: task.id, title })}
                onDone={onDoneEditing}
              />
            ) : canEdit ? (
              <button
                type="button"
                dir="auto"
                className={`w-full cursor-pointer rounded px-1 text-left hover:bg-field ${FOCUS}`}
                onClick={() => onEdit("title")}
              >
                {task.title}
              </button>
            ) : (
              <span dir="auto" className="block px-1">
                {task.title}
              </span>
            )}
          </h2>
          <button
            type="button"
            aria-label="Close"
            className={`flex size-8 flex-none cursor-pointer items-center justify-center rounded text-secondary hover:bg-field ${FOCUS}`}
            onClick={onClose}
          >
            <IconX size={18} stroke={1.75} aria-hidden />
          </button>
        </div>

        <StatusControl
          status={task.status}
          disabled={!canSetStatus}
          onChange={(status) => {
            if (status !== task.status) {
              void changes.setStatus(board.id, task, status);
            }
          }}
        />

        <div className="flex flex-col gap-3">
          {board.kind === "team" && (
            <Fact label="Assigned to">
              {task.assignee && (
                <PersonAvatar
                  person={task.assignee}
                  email={
                    assignees.find((member) => member.id === task.assignee?.id)
                      ?.email
                  }
                />
              )}
              {canEdit ? (
                <select
                  aria-label="Assigned to"
                  className={`${FIELD} min-w-0 flex-1`}
                  value={task.assignee?.id ?? ""}
                  onChange={(event) =>
                    send({
                      kind: "assign",
                      id: task.id,
                      assigneeId: (event.target.value || null) as UserId | null,
                    })
                  }
                >
                  <option value="">Nobody yet</option>
                  {assigneeGone && task.assignee && (
                    <option value={task.assignee.id} disabled>
                      {task.assignee.name}
                    </option>
                  )}
                  <optgroup label={`On ${board.name}`}>
                    {assignees.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.id === me
                          ? `${member.name} (you)`
                          : member.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              ) : (
                <span className="pt-1">
                  {task.assignee?.name ?? "Nobody yet"}
                </span>
              )}
            </Fact>
          )}
          <Fact label="Due">
            {canEdit ? (
              <>
                <input
                  type="date"
                  aria-label="Due date"
                  className={`${FIELD} min-w-0 flex-1`}
                  value={task.due ?? ""}
                  onChange={(event) =>
                    send({
                      kind: "setDue",
                      id: task.id,
                      due: parsePlainDate(event.target.value),
                    })
                  }
                />
                {task.due && (
                  <button
                    type="button"
                    className={`h-7 cursor-pointer rounded px-1.5 text-xs text-accent hover:underline ${FOCUS}`}
                    onClick={() =>
                      send({ kind: "setDue", id: task.id, due: null })
                    }
                  >
                    Clear
                  </button>
                )}
              </>
            ) : (
              <span className="pt-1">
                {task.due ? dayText(task.due) : "No date"}
              </span>
            )}
          </Fact>
          <Fact label="Board">
            <span className="pt-1">
              <BoardName board={board} />
            </span>
          </Fact>
        </div>

        <section className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold">Notes</h3>
            {canEdit && !isEditing(state, "notes") && (
              <button
                type="button"
                aria-label="Edit notes"
                className={`flex size-7 cursor-pointer items-center justify-center rounded text-secondary hover:bg-field hover:text-text ${FOCUS}`}
                onClick={() => onEdit("notes")}
              >
                <IconPencil size={15} stroke={1.75} aria-hidden />
              </button>
            )}
          </div>
          {isEditing(state, "notes") ? (
            <InPlaceText
              value={task.notes}
              label="Notes"
              multiline
              maxLength={LIMITS.notes * 2}
              className="text-[13px]"
              onSave={(notes) => send({ kind: "setNotes", id: task.id, notes })}
              onDone={onDoneEditing}
            />
          ) : task.notes ? (
            <p
              dir="auto"
              className="text-[13px] break-words whitespace-pre-wrap"
            >
              <NotesText notes={task.notes} />
            </p>
          ) : canEdit ? (
            <button
              type="button"
              className={`cursor-pointer rounded border border-dashed border-line px-2 py-2 text-left text-[13px] text-secondary hover:bg-field ${FOCUS}`}
              onClick={() => onEdit("notes")}
            >
              Add notes
            </button>
          ) : (
            <p className="text-[13px] text-secondary">No notes.</p>
          )}
        </section>

        <Checklist
          task={task}
          boardId={board.id}
          canEdit={canEdit}
          state={state}
          onEdit={onEdit}
          onDone={onDoneEditing}
          changes={changes}
        />

        <div className="mt-auto flex flex-col gap-2 border-t border-line pt-3">
          <p className="text-xs text-secondary">
            Added by {task.createdBy.id === me ? "you" : task.createdBy.name}
          </p>
          {canEdit && (
            <div>
              <Button
                variant="danger"
                icon={IconTrash}
                onClick={() => {
                  onClose();
                  void changes.remove(board.id, task);
                }}
              >
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

const dayText = (due: PlainDate) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${due}T00:00:00Z`));
