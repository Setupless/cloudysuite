import type { BoardId } from "@cloudysuite/access";
import { dehydrate, QueryClient, queryOptions } from "@tanstack/react-query";
import {
  boardMembers,
  listBoardTasks,
  listMyBoards,
  listMyTasks,
} from "./functions";

const CANNOT_REACH =
  "We couldn't reach CloudySuite. Check your connection and try again.";
const SOMETHING_WENT_WRONG =
  "Something went wrong on our side. Try again in a moment.";

export class TasksFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// A refusal from a server function arrives as a thrown Response. What the person sees is
// the plain message the server wrote, or a plain message from here.
async function asFailure(thrown: unknown): Promise<TasksFailure> {
  if (thrown instanceof TasksFailure) return thrown;
  if (!(thrown instanceof Response)) return new TasksFailure(0, CANNOT_REACH);
  const body = (await thrown
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown } | null;
  return new TasksFailure(
    thrown.status,
    typeof body?.message === "string" ? body.message : SOMETHING_WENT_WRONG,
  );
}

export async function call<Result>(run: () => Promise<Result>) {
  try {
    return await run();
  } catch (thrown) {
    throw await asFailure(thrown);
  }
}

export const retryUnlessRefused = (failures: number, error: Error): boolean =>
  !(
    error instanceof TasksFailure &&
    error.status >= 400 &&
    error.status < 500
  ) && failures < 2;

export const tasksKeys = {
  all: ["tasks"] as const,
  boards: ["tasks", "boards"] as const,
  mine: ["tasks", "mine"] as const,
  board: (boardId: BoardId) => ["tasks", "board", boardId] as const,
  members: (boardId: BoardId) => ["tasks", "members", boardId] as const,
};

export const boardsQuery = () =>
  queryOptions({
    queryKey: tasksKeys.boards,
    queryFn: () => call(() => listMyBoards()),
  });

export const myTasksQuery = () =>
  queryOptions({
    queryKey: tasksKeys.mine,
    queryFn: () => call(() => listMyTasks()),
  });

export const boardTasksQuery = (boardId: BoardId) =>
  queryOptions({
    queryKey: tasksKeys.board(boardId),
    queryFn: () => call(() => listBoardTasks({ data: { boardId } })),
  });

export const membersQuery = (boardId: BoardId) =>
  queryOptions({
    queryKey: tasksKeys.members(boardId),
    queryFn: () => call(() => boardMembers({ data: { boardId } })),
  });

// The first HTML holds the data, so the page draws it as soon as the browser knows what
// day it is.
async function prefetch(fill: (client: QueryClient) => Promise<void>) {
  if (!import.meta.env.SSR) return undefined;
  const client = new QueryClient();
  await fill(client);
  return dehydrate(client);
}

export const prefetchBoards = () =>
  prefetch((client) => client.prefetchQuery(boardsQuery()));

export const prefetchMyTasks = () =>
  prefetch((client) => client.prefetchQuery(myTasksQuery()));

export const prefetchBoard = (boardId: string) =>
  prefetch((client) =>
    client.prefetchQuery(boardTasksQuery(boardId as BoardId)),
  );
