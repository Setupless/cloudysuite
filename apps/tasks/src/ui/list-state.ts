import type { ChecklistItemId, TaskId } from "../types";

// The one part of the panel being typed into, so Esc puts that back before it closes
// anything.
export type Editing = "title" | "notes" | { item: ChecklistItemId };

// A list is being looked at, has its New task row open, or has a task open beside it.
export type ListState =
  | { kind: "browsing" }
  | { kind: "adding" }
  | { kind: "open"; taskId: TaskId; editing: Editing | null };

export type ListAction =
  | { type: "startAdding" }
  | { type: "open"; taskId: TaskId }
  | { type: "edit"; field: Editing }
  | { type: "stopEditing" }
  | { type: "close" };

export const BROWSING: ListState = { kind: "browsing" };

export function listReducer(state: ListState, action: ListAction): ListState {
  switch (action.type) {
    case "startAdding":
      return { kind: "adding" };
    case "open":
      return state.kind === "open" && state.taskId === action.taskId
        ? state
        : { kind: "open", taskId: action.taskId, editing: null };
    case "edit":
      return state.kind === "open"
        ? { ...state, editing: action.field }
        : state;
    case "stopEditing":
      return state.kind === "open" ? { ...state, editing: null } : state;
    case "close":
      return BROWSING;
  }
}

export const isEditing = (state: ListState, field: Editing) =>
  state.kind === "open" &&
  state.editing !== null &&
  (typeof field === "string"
    ? state.editing === field
    : typeof state.editing === "object" && state.editing.item === field.item);

// A page asked to open a task starts with it open.
export const openingWith = (taskId: string | undefined): ListState =>
  taskId ? { kind: "open", taskId: taskId as TaskId, editing: null } : BROWSING;
