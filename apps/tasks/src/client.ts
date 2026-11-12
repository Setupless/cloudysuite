import {
  type BoardGrant,
  type BoardId,
  type BoardKind,
  type BoardRole,
  checkBoardAccess,
  type UserId,
} from "@cloudysuite/access";
import type { Actor } from "./store";
import { boardStub } from "./stub";
import type { ChangeResult, Task, TaskChange, TaskId } from "./types";

export type BoardClient = {
  boardId: BoardId;
  role: BoardRole;
  kind: BoardKind;
  listTasks(): Promise<Task[]>;
  listMyTasks(doneSince: number): Promise<Task[]>;
  findTask(id: TaskId): Promise<Task | null>;
  change(change: TaskChange): Promise<ChangeResult>;
};

// The only way for user-facing code to reach a board. A grant cannot cross RPC, so D1's
// part of the check happens here, on the caller's side, and every call tells the object
// who is asking.
export function openBoard(env: Env, grant: BoardGrant): BoardClient {
  const stub = boardStub(env, grant.boardId);
  const actor: Actor = {
    userId: grant.userId,
    boardId: grant.boardId,
    role: grant.role,
    kind: grant.kind,
  };
  return {
    boardId: grant.boardId,
    role: grant.role,
    kind: grant.kind,
    listTasks: async () => (await stub.listTasks(actor)) as Task[],
    listMyTasks: async (doneSince) =>
      (await stub.listMyTasks(actor, doneSince)) as Task[],
    findTask: async (id) => (await stub.findTask(actor, id)) as Task | null,
    change: async (change) =>
      (await stub.changeTask(actor, change)) as ChangeResult,
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
