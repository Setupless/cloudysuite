import type { BoardId, UserId } from "@cloudysuite/access";
import type { MoveOutcome, Task } from "./types";

// Two boards can't share a transaction, so for a moment both may hold the task. Only
// one of them ever shows it, and only an unlocked task can change:
//
//   sender      receiver     who shows the task
//   locked      none/locked  the sender, as "Moving to Product…"
//   added       locked       nobody, for the moment the unlock takes
//   (gone)      unlocked     the receiver
//   givenUp     none/locked  the sender, unlocked. The receiver's copy is dropped.
//
// Each sender step repeats from the alarm until it gets an answer, and each receiver
// step changes nothing the second time.
export type OutgoingPhase = "locked" | "added" | "givenUp";

// What the sender hears, or decides. A move that ends has no row.
export type OutgoingEvent =
  "added" | "refused" | "noAnswer" | "unlocked" | "dropped";

export const OUTGOING_STEPS: Record<
  OutgoingPhase,
  Partial<Record<OutgoingEvent, OutgoingPhase | "ended">>
> = {
  locked: { added: "added", refused: "ended", noAnswer: "givenUp" },
  added: { unlocked: "ended" },
  givenUp: { dropped: "ended" },
};

// The receiver keeps every move id it has heard of, in one of these. A drop for a move
// it never heard of is kept too, in case the delivery is still on its way.
export type IncomingPhase = "locked" | "unlocked" | "dropped";

export type IncomingEvent = "add" | "unlock" | "drop";

export const INCOMING_STEPS: Record<
  IncomingPhase | "unheard",
  Partial<Record<IncomingEvent, IncomingPhase>>
> = {
  unheard: { add: "locked", drop: "dropped" },
  locked: { unlock: "unlocked", drop: "dropped" },
  unlocked: {},
  dropped: {},
};

// What crosses from the sender to the receiver.
export type MoveDelivery = { moveId: string; task: Task };

export type OutgoingMove = {
  moveId: string;
  phase: OutgoingPhase;
  toBoardId: BoardId;
  movedBy: UserId;
  task: Task;
  giveUpAt: number;
};

export type ReceiveRefusal = Extract<
  MoveOutcome,
  { status: "refusedThere" }
>["reason"];

export type ReceiveAnswer =
  { status: "added" } | { status: "refused"; reason: ReceiveRefusal };
