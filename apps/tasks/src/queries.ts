import type { BoardId } from "@cloudysuite/access";
import type { UserId } from "@cloudysuite/access";
import type { TaskId } from "./types";
import {
  dehydrate,
  keepPreviousData,
  MutationCache,
  noop,
  QueryCache,
  QueryClient,
  type QueryExecuteOptions,
  type QueryKey,
  queryOptions,
} from "@tanstack/react-query";
import {
  assignmentEmail,
  boardSettings,
  countBoardTasks,
  listBoardTasks,
  listColleagues,
  listMyBoards,
  listMoveNotices,
  listMyTasks,
  listPersonTasks,
  searchTasks,
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

// An expired session surfaces here first. The reload reaches the route's sign-in check,
// which sends the person to sign in and back again.
function reloadIfSignedOut(error: Error) {
  if (error instanceof TasksFailure && error.status === 401) {
    window.location.reload();
  }
}

function createTasksQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: reloadIfSignedOut }),
    mutationCache: new MutationCache({ onError: reloadIfSignedOut }),
    defaultOptions: {
      mutations: { networkMode: "always" },
      queries: {
        networkMode: "always",
        // Only long enough that the first HTML's data isn't fetched again as the page
        // wakes up.
        staleTime: 2_000,
        retry: retryUnlessRefused,
        refetchOnWindowFocus: true,
      },
    },
  });
}

let browserClient: QueryClient | undefined;

// The browser keeps one for the page, which the route loaders fill and the screens read.
// The server makes a new one each time: a shared one would leak one person's tasks into
// the next person's page.
export function tasksQueryClient(): QueryClient {
  if (import.meta.env.SSR) return createTasksQueryClient();
  browserClient ??= createTasksQueryClient();
  return browserClient;
}

export const tasksKeys = {
  all: ["tasks"] as const,
  boards: ["tasks", "boards"] as const,
  mine: ["tasks", "mine"] as const,
  board: (boardId: BoardId) => ["tasks", "board", boardId] as const,
  settings: (boardId: BoardId) => ["tasks", "settings", boardId] as const,
  taskCount: (boardId: BoardId) => ["tasks", "taskCount", boardId] as const,
  colleagues: ["tasks", "colleagues"] as const,
  moveNotices: ["tasks", "moveNotices"] as const,
  searches: ["tasks", "search"] as const,
  search: (text: string, boardId: BoardId | null) =>
    ["tasks", "search", text, boardId] as const,
  people: ["tasks", "person"] as const,
  person: (userId: UserId) => ["tasks", "person", userId] as const,
  assignmentEmail: (boardId: BoardId, taskId: TaskId, assigneeId: UserId) =>
    ["tasks", "assignmentEmail", boardId, taskId, assigneeId] as const,
};

// A task on its way to another board shows that, and the list asks again until it's gone.
const MOVING_CHECK_MS = 10_000;
const whileMoving = (tasks: { moving: unknown }[] | undefined) =>
  tasks?.some((task) => task.moving) ? MOVING_CHECK_MS : false;

// The email waits 10 seconds, so a refusal shows soon after it happens.
const EMAIL_CHECK_MS = 5_000;

export const assignmentEmailQuery = (
  boardId: BoardId,
  taskId: TaskId,
  assigneeId: UserId,
) =>
  queryOptions({
    queryKey: tasksKeys.assignmentEmail(boardId, taskId, assigneeId),
    queryFn: () => call(() => assignmentEmail({ data: { boardId, taskId } })),
    refetchInterval: (query) =>
      query.state.data?.state === "pending" ? EMAIL_CHECK_MS : false,
  });

// Every page shows these, and asks again as it opens, so a note written while the person
// was elsewhere shows on the next page they go to.
export const moveNoticesQuery = () =>
  queryOptions({
    queryKey: tasksKeys.moveNotices,
    queryFn: () => call(() => listMoveNotices()),
  });

export const boardsQuery = () =>
  queryOptions({
    queryKey: tasksKeys.boards,
    queryFn: () => call(() => listMyBoards()),
  });

export const myTasksQuery = () =>
  queryOptions({
    queryKey: tasksKeys.mine,
    queryFn: () => call(() => listMyTasks()),
    refetchInterval: (query) => whileMoving(query.state.data?.tasks),
  });

export const boardTasksQuery = (boardId: BoardId) =>
  queryOptions({
    queryKey: tasksKeys.board(boardId),
    queryFn: () => call(() => listBoardTasks({ data: { boardId } })),
    refetchInterval: (query) => whileMoving(query.state.data?.tasks),
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

// `boardId` is the board search started from, whose members come first.
export const searchQuery = (text: string, boardId: BoardId | null) =>
  queryOptions({
    queryKey: tasksKeys.search(text, boardId),
    queryFn: () => call(() => searchTasks({ data: { text, boardId } })),
    placeholderData: keepPreviousData,
  });

export const personTasksQuery = (userId: UserId) =>
  queryOptions({
    queryKey: tasksKeys.person(userId),
    queryFn: () => call(() => listPersonTasks({ data: { userId } })),
    refetchInterval: (query) => whileMoving(query.state.data?.tasks),
  });

// In the browser a navigation starts the page's first requests and doesn't wait for them,
// so the page draws its own loading state meanwhile. Only what the page doesn't hold yet
// is asked for, so preloading a page twice asks once: what it holds shows at once, and
// the page's own query asks again as it opens.
function startInBrowser<Data, Key extends QueryKey>(
  query: QueryExecuteOptions<Data, Error, Data, Data, Key>,
) {
  void tasksQueryClient()
    .query({ ...query, staleTime: "static" })
    .catch(noop);
  return undefined;
}

// The first HTML holds the data, so the page draws it as soon as the browser knows what
// day it is.
async function prefetch(fill: (client: QueryClient) => Promise<void>) {
  const client = new QueryClient();
  await fill(client);
  return dehydrate(client);
}

export async function prefetchBoards() {
  if (!import.meta.env.SSR) {
    startInBrowser(boardsQuery());
    startInBrowser(moveNoticesQuery());
    return undefined;
  }
  return prefetch(async (client) => {
    await Promise.all([
      client.prefetchQuery(boardsQuery()),
      client.prefetchQuery(moveNoticesQuery()),
    ]);
  });
}

export async function prefetchMyTasks() {
  if (!import.meta.env.SSR) return startInBrowser(myTasksQuery());
  return prefetch((client) => client.prefetchQuery(myTasksQuery()));
}

export async function prefetchBoard(boardId: string) {
  const query = boardTasksQuery(boardId as BoardId);
  if (!import.meta.env.SSR) return startInBrowser(query);
  return prefetch((client) => client.prefetchQuery(query));
}

const textOf = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

// Opens a task when the page loads, such as from "Moved to Product".
export const validateTaskSearch = (
  search: Record<string, unknown>,
): { task?: string } => {
  const task = textOf(search.task);
  return task ? { task } : {};
};

// A board can also show only one person's tasks, chosen from search.
export const validateBoardSearch = (
  search: Record<string, unknown>,
): { task?: string; person?: string } => {
  const person = textOf(search.person);
  return { ...validateTaskSearch(search), ...(person ? { person } : {}) };
};

// `board` is the board search started from.
export const validateSearchPage = (
  search: Record<string, unknown>,
): { q?: string; board?: string } => {
  const q = typeof search.q === "string" ? search.q : undefined;
  const board = textOf(search.board);
  return {
    ...(q !== undefined ? { q } : {}),
    ...(board ? { board } : {}),
  };
};
