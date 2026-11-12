import { env } from "cloudflare:workers";
import {
  type BoardId,
  ensurePersonalBoard,
  PERSONAL_BOARD_COLOUR,
  type UserId,
} from "@cloudysuite/access";
import { askEach } from "@cloudysuite/search";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { openBoardFor, requireTasksUser } from "./access";
import {
  createTeam,
  findMember,
  personOf,
  readMembers,
  readMyBoards,
} from "./directory";
import {
  type BoardEntry,
  type BoardTasks,
  type ChangeAnswer,
  type ChangeResult,
  DONE_TODAY_LOOKBACK_MS,
  type Member,
  type MyTask,
  type MyTasks,
  NOT_ON_BOARD_MESSAGE,
  type Person,
  REFUSAL_MESSAGES,
  type RefusalReason,
  type TaskChange,
  type TaskChangeInput,
} from "./types";
import {
  parseBoardInput,
  parseChangeInput,
  parseNewBoardInput,
  parseNewPrivateTaskInput,
  refusal,
} from "./wire";

const me = () => requireTasksUser(getRequest());

const REFUSAL_STATUS: Partial<Record<RefusalReason, number>> = {
  noAccess: 403,
  gone: 404,
  itemGone: 404,
  tooLateToUndo: 409,
};

function answer(result: ChangeResult): ChangeAnswer {
  if (result.status !== "refused") return result;
  throw refusal(REFUSAL_STATUS[result.reason] ?? 400, result.message);
}

// The name comes from the directory, never from the page.
async function assigneeOf(boardId: BoardId, userId: UserId | null) {
  if (userId === null) return null;
  const person = await findMember(env.DB, boardId, userId);
  if (!person) throw refusal(400, NOT_ON_BOARD_MESSAGE);
  return person;
}

async function changeOf(
  boardId: BoardId,
  input: TaskChangeInput,
  creator: Person,
): Promise<TaskChange> {
  switch (input.kind) {
    case "create": {
      const { assigneeId, ...rest } = input;
      return {
        ...rest,
        assignee: await assigneeOf(boardId, assigneeId),
        creatorName: creator.name,
      };
    }
    case "assign":
      return {
        kind: "assign",
        id: input.id,
        assignee: await assigneeOf(boardId, input.assigneeId),
      };
    default:
      return input;
  }
}

// Reads D1 only, so the sidebar wakes no Board object. My tasks covers the person's own
// board.
export const listMyBoards = createServerFn({ method: "GET" }).handler(
  async (): Promise<BoardEntry[]> =>
    (await readMyBoards(env.DB, await me())).filter(
      (entry) => entry.kind === "team",
    ),
);

export const listMyTasks = createServerFn({ method: "GET" }).handler(
  async (): Promise<MyTasks> => {
    const person = await me();
    const doneSince = Date.now() - DONE_TODAY_LOOKBACK_MS;
    const { answers, missing } = await askEach(
      await readMyBoards(env.DB, person),
      async ({ role: _role, ...board }): Promise<MyTask[]> => {
        const tasks = await (
          await openBoardFor(person.id, board.id)
        ).listMyTasks(doneSince);
        return tasks.map((task) => ({ ...task, board }));
      },
    );
    return { tasks: answers.flat(), unreachable: missing };
  },
);

export const listBoardTasks = createServerFn({ method: "GET" })
  .validator(parseBoardInput)
  .handler(async ({ data }): Promise<BoardTasks> => {
    const board = await openBoardFor((await me()).id, data.boardId);
    return {
      role: board.role,
      kind: board.kind,
      tasks: await board.listTasks(),
    };
  });

export const boardMembers = createServerFn({ method: "GET" })
  .validator(parseBoardInput)
  .handler(async ({ data }): Promise<Member[]> => {
    await openBoardFor((await me()).id, data.boardId);
    return readMembers(env.DB, data.boardId);
  });

export const changeTask = createServerFn({ method: "POST" })
  .validator(parseChangeInput)
  .handler(async ({ data }): Promise<ChangeAnswer> => {
    const person = await me();
    const board = await openBoardFor(person.id, data.boardId);
    const change = await changeOf(data.boardId, data.change, personOf(person));
    return answer(await board.change(change));
  });

// The person's own board is made on first use, which this is. Safe to repeat, so two
// tabs make one.
export const createPrivateTask = createServerFn({ method: "POST" })
  .validator(parseNewPrivateTaskInput)
  .handler(async ({ data }): Promise<MyTask> => {
    const person = await me();
    const boardId = await ensurePersonalBoard(env.DB, person.id);
    const board = await openBoardFor(person.id, boardId);
    const result = answer(
      await board.change({
        kind: "create",
        ...data,
        assignee: null,
        creatorName: personOf(person).name,
      }),
    );
    if (result.status !== "done") throw refusal(404, REFUSAL_MESSAGES.gone);
    return {
      ...result.task,
      board: {
        id: boardId,
        kind: "personal",
        name: person.name,
        colour: PERSONAL_BOARD_COLOUR,
      },
    };
  });

export const createTeamBoard = createServerFn({ method: "POST" })
  .validator(parseNewBoardInput)
  .handler(async ({ data }): Promise<BoardId> =>
    createTeam(env.DB, (await me()).id, data.name),
  );
