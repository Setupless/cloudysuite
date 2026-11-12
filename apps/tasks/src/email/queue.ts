import type { BoardId, UserId } from "@cloudysuite/access";
import type { NotEmailedReason, TaskId } from "../types";

// One task's assignment email, in the Board object's own queue:
// waiting → sending → sent, or notSent(reason), or unclear when it may have gone.
export const EMAIL_STATES = [
  "waiting",
  "sending",
  "sent",
  "notSent",
  "unclear",
] as const;
export type EmailState = (typeof EMAIL_STATES)[number];

export type EmailEvent =
  // Every check passed, and it's about to be handed to the service.
  | "claim"
  | "went"
  // A check failed, or the service refused it.
  | "refuse"
  // A rate limit, or a directory that didn't answer. Each counts as a try.
  | "tryLater"
  // The task is deleted, and waits out its Undo.
  | "wait"
  // The service gave no clear answer, or a claim was found from a run that never ended.
  | "unclear"
  // Nothing to send: the task is gone or is someone else's now.
  | "drop"
  // Something unforeseen stopped it before it was claimed.
  | "stop"
  // Try again.
  | "retry";

// An event a state doesn't list changes nothing, so a late or repeated step can't undo
// a later one. Sent is final, so Try again never sends twice.
export const EMAIL_STEPS: Record<
  EmailState,
  Partial<Record<EmailEvent, EmailState | "dropped">>
> = {
  waiting: {
    claim: "sending",
    refuse: "notSent",
    tryLater: "waiting",
    wait: "waiting",
    drop: "dropped",
    stop: "notSent",
  },
  sending: {
    went: "sent",
    refuse: "notSent",
    tryLater: "waiting",
    unclear: "unclear",
  },
  sent: {},
  notSent: { retry: "waiting" },
  unclear: { retry: "waiting" },
};

// A due email as the alarm reads it. `emailId` is new for each assignment, so settling
// an older attempt can't settle a newer one.
export type QueuedEmail = {
  emailId: string;
  taskId: TaskId;
  boardId: BoardId;
  assigneeId: UserId;
  // Who assigned the task, or chose Try again. It goes from their address.
  assignedBy: UserId;
  state: "waiting" | "sending";
  // Rate limits and unanswered checks met so far.
  tries: number;
};

// What the checks before each attempt can find wrong, in the order they're made.
export type CheckFailure =
  | "taskGone"
  | "taskDeleted"
  | "reassigned"
  | "tasksOff"
  | "mailOff"
  | "noAppDomain"
  | "assigneeCantOpen"
  | "assignerCantEdit"
  | "noSender"
  | "noAddress";

export type CheckOutcome =
  | { kind: "drop" }
  | { kind: "wait" }
  | { kind: "refuse"; reason: NotEmailedReason };

// A task deleted while it waits may come back with Undo, so it waits that out. Once it's
// purged, its email goes with it.
export const WHEN_CHECK_FAILS: Record<CheckFailure, CheckOutcome> = {
  taskGone: { kind: "drop" },
  taskDeleted: { kind: "wait" },
  reassigned: { kind: "drop" },
  tasksOff: { kind: "refuse", reason: "tasksOff" },
  mailOff: { kind: "refuse", reason: "mailOff" },
  noAppDomain: { kind: "refuse", reason: "checkUnavailable" },
  assigneeCantOpen: { kind: "refuse", reason: "assigneeCantOpen" },
  assignerCantEdit: { kind: "refuse", reason: "assignerCantEdit" },
  noSender: { kind: "refuse", reason: "noSender" },
  noAddress: { kind: "refuse", reason: "noAddress" },
};
