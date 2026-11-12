import type { UserId } from "@cloudysuite/access";
import { Button } from "@cloudysuite/ui";
import { type FormEvent, useRef, useState } from "react";
import { type Member, type PlainDate, parsePlainDate } from "../types";
import { addDays } from "./dates";
import { FOCUS } from "./parts";

export type NewTaskDraft = {
  title: string;
  due: PlainDate | null;
  assigneeId: UserId | null;
};

const CHIP = `h-7 cursor-pointer rounded-full border px-2.5 text-xs ${FOCUS}`;
const chipClass = (pressed: boolean) =>
  `${CHIP} ${pressed ? "border-accent bg-selected font-medium text-accent" : "border-line bg-panel text-text hover:bg-field"}`;

export const FIELD = `h-7 rounded border border-line bg-field px-2 text-xs text-text disabled:opacity-60 ${FOCUS}`;

// The one way to add a task. On a team board `members` offers someone to assign, and the
// task starts with nobody.
export function NewTaskRow({
  today,
  members,
  onAdd,
  onCancel,
}: {
  today: PlainDate;
  members: Member[] | null;
  // Resolves true once saved, so the row empties for the next one.
  onAdd: (draft: NewTaskDraft) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState<PlainDate | null>(null);
  const [assigneeId, setAssigneeId] = useState<UserId | null>(null);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const tomorrow = addDays(today, 1);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === "" || saving) return;
    setSaving(true);
    const saved = await onAdd({ title, due, assigneeId });
    setSaving(false);
    if (saved) {
      setTitle("");
      setDue(null);
      setAssigneeId(null);
    }
    field.current?.focus();
  }

  const quickDay = (day: PlainDate, label: string) => (
    <button
      type="button"
      aria-pressed={due === day}
      className={chipClass(due === day)}
      onClick={() => setDue(due === day ? null : day)}
    >
      {label}
    </button>
  );

  return (
    <li className="border-b border-line bg-panel">
      <form
        onSubmit={submit}
        aria-label="New task"
        className="flex flex-col gap-2 py-2 pr-2 pl-3"
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="size-[18px] flex-none rounded-full border-[1.5px] border-line"
          />
          <input
            ref={field}
            autoFocus
            aria-label="Task title"
            placeholder="New task"
            value={title}
            disabled={saving}
            maxLength={800}
            className="min-h-9 min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-secondary"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-[30px]">
          {quickDay(today, "Today")}
          {quickDay(tomorrow, "Tomorrow")}
          <input
            type="date"
            aria-label="Due date"
            className={FIELD}
            value={due ?? ""}
            onChange={(event) => setDue(parsePlainDate(event.target.value))}
          />
          {members && (
            <select
              aria-label="Assigned to"
              className={FIELD}
              value={assigneeId ?? ""}
              onChange={(event) =>
                setAssigneeId((event.target.value || null) as UserId | null)
              }
            >
              <option value="">Nobody yet</option>
              <optgroup label="On this board">
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </optgroup>
            </select>
          )}
          <span className="ml-auto flex gap-1.5">
            <Button variant="toolbar" disabled={saving} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="toolbarAction"
              pending={saving}
              disabled={title.trim() === ""}
            >
              Add task
            </Button>
          </span>
        </div>
      </form>
    </li>
  );
}
