import {
  type BoardGrant,
  type BoardId,
  type BoardKind,
  type BoardRole,
  checkBoardAccess,
  type UserId,
} from "@cloudysuite/access";
import type { SearchTerm } from "@cloudysuite/search";
import type { MoveDelivery, ReceiveAnswer } from "./moves";
import type { Actor } from "./store";
import { boardStub } from "./stub";
import type {
  AssignmentEmailStatus,
  BoardMoveNotice,
  ChangeResult,
  MoveDestination,
  MoveOutcome,
  Task,
  TaskChange,
  TaskId,
} from "./types";

export type BoardClient = {
  boardId: BoardId;
  role: BoardRole;
  kind: BoardKind;
  listTasks(): Promise<Task[]>;
  listMyTasks(doneSince: number): Promise<Task[]>;
  listOpenFor(assigneeId: UserId): Promise<Task[]>;
  search(terms: SearchTerm[]): Promise<{ tasks: Task[]; more: boolean }>;
  findTask(id: TaskId): Promise<Task | null>;
  change(change: TaskChange): Promise<ChangeResult>;
  countTasks(): Promise<number>;
  erase(): Promise<"done" | "noAccess">;
  // Taking the other board's client means its access check has already passed.
  moveTo(
    id: TaskId,
    to: BoardClient,
    move: { to: MoveDestination; keepAssigneeId: UserId | null },
  ): Promise<MoveOutcome>;
  assignmentEmail(id: TaskId): Promise<AssignmentEmailStatus>;
  retryAssignmentEmail(id: TaskId): Promise<"done" | "noAccess">;
};

const actorOf = (grant: BoardGrant): Actor => ({
  userId: grant.userId,
  boardId: grant.boardId,
  role: grant.role,
  kind: grant.kind,
});

// The only way for user-facing code to reach a board. A grant cannot cross RPC, so D1's
// part of the check happens here, on the caller's side, and every call tells the object
// who is asking.
export function openBoard(env: Env, grant: BoardGrant): BoardClient {
  const stub = boardStub(env, grant.boardId);
  const actor = actorOf(grant);
  return {
    boardId: grant.boardId,
    role: grant.role,
    kind: grant.kind,
    listTasks: async () => (await stub.listTasks(actor)) as Task[],
    listMyTasks: async (doneSince) =>
      (await stub.listMyTasks(actor, doneSince)) as Task[],
    listOpenFor: async (assigneeId) =>
      (await stub.listOpenFor(actor, assigneeId)) as Task[],
    search: async (terms) =>
      (await stub.searchTasks(actor, terms)) as {
        tasks: Task[];
        more: boolean;
      },
    findTask: async (id) => (await stub.findTask(actor, id)) as Task | null,
    change: async (change) =>
      (await stub.changeTask(actor, change)) as ChangeResult,
    countTasks: () => stub.countTasks(actor),
    erase: () => stub.erase(actor),
    moveTo: async (id, to, move) =>
      (await stub.moveTask(actor, {
        id,
        toBoardId: to.boardId,
        ...move,
      })) as MoveOutcome,
    assignmentEmail: async (id) =>
      (await stub.assignmentEmail(actor, id)) as AssignmentEmailStatus,
    retryAssignmentEmail: (id) => stub.retryAssignmentEmail(actor, id),
  };
}

// For one request. A board that doesn't exist, someone not on it, or a banned person
// gets null.
export async function openBoardAs(
  env: Env,
  userId: UserId,
  boardId: BoardId,
): Promise<BoardClient | null> {
  const access = await checkBoardAccess(env.DB, userId, boardId);
  return access.allowed ? openBoard(env, access.grant) : null;
}

// For one board's object to carry a move into another, perhaps from its alarm after the
// person has gone. Each delivery checks the mover's grant there again, so a deleted
// board or lost Can edit refuses it. Unlocking and dropping only finish or undo a
// delivery that grant allowed, and refusing them would leave the task locked.
export function moveReceiver(env: Env, boardId: BoardId) {
  const stub = boardStub(env, boardId);
  return {
    async add(movedBy: UserId, delivery: MoveDelivery): Promise<ReceiveAnswer> {
      const access = await checkBoardAccess(env.DB, movedBy, boardId);
      if (!access.allowed) return { status: "refused", reason: "noAccess" };
      return (await stub.receiveMove(
        actorOf(access.grant),
        delivery,
      )) as ReceiveAnswer;
    },
    unlock: async (moveId: string) => {
      await stub.unlockMoveIn(moveId);
    },
    drop: async (moveId: string) => {
      await stub.dropMoveIn(moveId);
    },
  };
}

// A person's own notes about their moves from this board. They keep them after losing
// the board, when the access check leaves out each task's title.
export async function moveNoticesOn(
  env: Env,
  userId: UserId,
  boardId: BoardId,
) {
  const stub = boardStub(env, boardId);
  const access = await checkBoardAccess(env.DB, userId, boardId);
  const reader = { userId, canOpen: access.allowed };
  return {
    list: async () => (await stub.moveNotices(reader)) as BoardMoveNotice[],
    dismiss: (moveId: string) => stub.dismissMoveNotice(reader, moveId),
  };
}

// For a board's alarm, after the person has gone: their role there now, or null when
// they can no longer open it.
export async function roleNow(
  database: D1Database,
  userId: UserId,
  boardId: BoardId,
): Promise<BoardRole | null> {
  const access = await checkBoardAccess(database, userId, boardId);
  return access.allowed ? access.grant.role : null;
}
