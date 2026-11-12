import type { BoardId } from "@cloudysuite/access";
import { dehydrate, QueryClient, queryOptions } from "@tanstack/react-query";
import {
  boardSettings,
  countBoardTasks,
  listBoardTasks,
  listColleagues,
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
  settings: (boardId: BoardId) => ["tasks", "settings", boardId] as const,
  taskCount: (boardId: BoardId) => ["tasks", "taskCount", boardId] as const,
  colleagues: ["tasks", "colleagues"] as const,
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

export const settingsQuery = (boardId: BoardId) =>
  queryOptions({
    queryKey: tasksKeys.settings(boardId),
    queryFn: () => call(() => boardSettings({ data: { boardId } })),
  });

// Asked fresh each time, because it's what the delete confirmation promises.
export const taskCountQuery = (boardId: BoardId) =>
  queryOptions({
    queryKey: tasksKeys.taskCount(boardId),
    queryFn: () => call(() => countBoardTasks({ data: { boardId } })),
    staleTime: 0,
    gcTime: 0,
  });

export const colleaguesQuery = () =>
  queryOptions({
    queryKey: tasksKeys.colleagues,
    queryFn: () => call(() => listColleagues()),
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
