import { env } from "cloudflare:workers";
import {
  type BoardId,
  ensurePersonalBoard,
  levelOfRole,
  PERSONAL_BOARD_COLOUR,
  readOthers,
  type UserId,
} from "@cloudysuite/access";
import { askEach } from "@cloudysuite/search";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { openBoardFor, requireTasksUser } from "./access";
import { type BoardClient, moveNoticesOn } from "./client";
import { noticesAcrossBoards } from "./move-notices";
import { searchBoards, tasksOfPerson } from "./search";
import { parseTaskSearch } from "./search-query";
import {
  addToTeam,
  createTeam,
  deleteTeam,
  findMember,
  isAddable,
  isOnBoard,
  personOf,
  readColleague,
  readMyBoards,
  readSettings,
  removeMember,
  renameTeam,
  setColour,
  setMemberRole,
  type TeamChange,
} from "./directory";
import {
  ADDED_WHILE_ASSIGNING_ROLE,
  ALREADY_THERE_MESSAGE,
  type BoardEntry,
  type BoardSettings,
  type BoardTasks,
  type AssignmentEmailStatus,
  type ChangeAnswer,
  type ChangeResult,
  type Colleague,
  DONE_TODAY_LOOKBACK_MS,
  LAST_MANAGER_MESSAGE,
  type MoveAnswer,
  type MoveNotice,
  type MyTask,
  type MyTasks,
  type PersonTasks,
  mayChangeSettings,
  NO_ACCESS_MESSAGE,
  NOT_A_PERSON_MESSAGE,
  NOT_ON_BOARD_MESSAGE,
  NOT_ON_IT_MESSAGE,
  NO_PERSON_MESSAGE,
  ONLY_MANAGERS_MESSAGE,
  type Person,
  PRIVATE_BOARD_MESSAGE,
  REFUSAL_MESSAGES,
  type Refusal,
  type RefusalReason,
  refusedThereMessage,
  type SettingsChange,
  type TaskChange,
  type TaskChangeInput,
  type TaskSearchAnswer,
  viewOnlyThereMessage,
} from "./types";
import {
  parseAddAndAssignInput,
  parseBoardInput,
  parseChangeInput,
  parseMoveInput,
  parseMoveNoticeInput,
  parseNewBoardInput,
  parseNewPrivateTaskInput,
  parsePersonInput,
  parseSearchInput,
  parseSettingsChangeInput,
  parseTaskInput,
  refusal,
} from "./wire";

const me = () => requireTasksUser(getRequest());

const REFUSAL_STATUS: Partial<Record<RefusalReason, number>> = {
  noAccess: 403,
  gone: 404,
  itemGone: 404,
  tooLateToUndo: 409,
  moving: 409,
  boardGone: 404,
};

const refused = (result: Refusal) =>
  refusal(REFUSAL_STATUS[result.reason] ?? 400, result.message);

function answer(result: ChangeResult): ChangeAnswer {
  if (result.status !== "refused") return result;
  throw refused(result);
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

// A person's own board has no settings: nobody else can be on it.
async function openTeamFor(userId: UserId, boardId: BoardId) {
  const board = await openBoardFor(userId, boardId);
  if (board.kind !== "team") throw refusal(403, PRIVATE_BOARD_MESSAGE);
  return board;
}

// Everyone on a board sees who else is on it.
export const boardSettings = createServerFn({ method: "GET" })
  .validator(parseBoardInput)
  .handler(async ({ data }): Promise<BoardSettings> => {
    const board = await openTeamFor((await me()).id, data.boardId);
    const settings = await readSettings(env.DB, data.boardId, board.role);
    if (!settings) throw refusal(403, NO_ACCESS_MESSAGE);
    return settings;
  });

// Everyone else in the organisation, for the pickers. It names no board, so it reads D1
// only.
export const listColleagues = createServerFn({ method: "GET" }).handler(
  async (): Promise<Colleague[]> => readOthers(env.DB, (await me()).id),
);

// Wakes the Board object, so only the delete confirmation asks.
export const countBoardTasks = createServerFn({ method: "GET" })
  .validator(parseBoardInput)
  .handler(async ({ data }): Promise<number> =>
    (await openTeamFor((await me()).id, data.boardId)).countTasks(),
  );

function answerTeamChange(change: TeamChange): void {
  switch (change) {
    case "done":
      return;
    case "lastManager":
      throw refusal(409, LAST_MANAGER_MESSAGE);
    case "notOnIt":
      throw refusal(404, NOT_ON_IT_MESSAGE);
  }
}

async function requireAddable(userId: UserId) {
  if (!(await isAddable(env.DB, userId))) {
    throw refusal(404, NOT_A_PERSON_MESSAGE);
  }
}

// The object first, so a failure leaves the board listed for its manager to delete
// again. Once emptied it refuses every change, so nothing new lands there before D1
// forgets it.
async function deleteBoard(board: BoardClient) {
  if ((await board.erase()) === "noAccess") {
    throw refusal(403, ONLY_MANAGERS_MESSAGE);
  }
  await deleteTeam(env.DB, board.boardId);
}

async function settle(
  board: BoardClient,
  me: UserId,
  change: SettingsChange,
): Promise<void> {
  const boardId = board.boardId;
  switch (change.kind) {
    case "add":
      await requireAddable(change.userId);
      return addToTeam(env.DB, boardId, change.userId, change.role);
    case "setRole":
      return answerTeamChange(
        await setMemberRole(env.DB, boardId, change.userId, change.role),
      );
    case "remove":
      return answerTeamChange(
        await removeMember(env.DB, boardId, change.userId),
      );
    case "leave":
      return answerTeamChange(await removeMember(env.DB, boardId, me));
    case "rename":
      return renameTeam(env.DB, boardId, change.name);
    case "setColour":
      return setColour(env.DB, boardId, change.colour);
    case "delete":
      return deleteBoard(board);
  }
}

// Who may make each change is in MAY_CHANGE_SETTINGS. Hiding a control is a courtesy,
// and this is the check.
export const changeBoardSettings = createServerFn({ method: "POST" })
  .validator(parseSettingsChangeInput)
  .handler(async ({ data }): Promise<void> => {
    const { id } = await me();
    const board = await openTeamFor(id, data.boardId);
    if (!mayChangeSettings(board.role, data.change.kind)) {
      throw refusal(403, ONLY_MANAGERS_MESSAGE);
    }
    await settle(board, id, data.change);
  });

// A manager who picks someone from the rest of the organisation adds them with Can edit,
// then assigns them. Someone already on the board keeps their role, so this is safe to
// repeat.
export const addAndAssign = createServerFn({ method: "POST" })
  .validator(parseAddAndAssignInput)
  .handler(async ({ data }): Promise<ChangeAnswer> => {
    const { id } = await me();
    const board = await openTeamFor(id, data.boardId);
    if (!mayChangeSettings(board.role, "add")) {
      throw refusal(403, ONLY_MANAGERS_MESSAGE);
    }
    await requireAddable(data.userId);
    await addToTeam(
      env.DB,
      data.boardId,
      data.userId,
      ADDED_WHILE_ASSIGNING_ROLE,
    );
    const assignee = await assigneeOf(data.boardId, data.userId);
    return answer(
      await board.change({ kind: "assign", id: data.taskId, assignee }),
    );
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

const canEdit = (board: BoardClient) => levelOfRole(board.role) === "edit";

// Moving needs Can edit on both boards. The assignee goes along only if they're on the
// other board, which the dialog has said first.
export const moveTask = createServerFn({ method: "POST" })
  .validator(parseMoveInput)
  .handler(async ({ data }): Promise<MoveAnswer> => {
    const person = await me();
    const from = await openBoardFor(person.id, data.boardId);
    if (!canEdit(from)) throw refusal(403, REFUSAL_MESSAGES.noAccess);
    const toBoardId =
      data.to === "private"
        ? await ensurePersonalBoard(env.DB, person.id)
        : data.to;
    if (toBoardId === data.boardId) throw refusal(409, ALREADY_THERE_MESSAGE);
    const to = await openBoardFor(person.id, toBoardId);
    const entry = (await readMyBoards(env.DB, person)).find(
      (board) => board.id === toBoardId,
    );
    if (!entry) throw refusal(403, NO_ACCESS_MESSAGE);
    const { role: _role, ...destination } = entry;
    const named =
      destination.kind === "personal" ? "your private tasks" : destination.name;
    if (!canEdit(to)) throw refusal(403, viewOnlyThereMessage(named));
    const task = await from.findTask(data.taskId);
    if (!task) throw refusal(404, REFUSAL_MESSAGES.gone);
    const keepAssigneeId =
      task.assignee &&
      to.kind === "team" &&
      (await isOnBoard(env.DB, toBoardId, task.assignee.id))
        ? task.assignee.id
        : null;
    const outcome = await from.moveTo(data.taskId, to, {
      to: { kind: destination.kind, name: destination.name },
      keepAssigneeId,
    });
    switch (outcome.status) {
      case "moved":
        return { status: "moved", to: destination };
      case "pending":
        return { status: "moving", to: destination };
      case "refusedThere":
        throw refusal(409, refusedThereMessage(outcome.reason, named));
      case "refused":
        throw refused(outcome);
    }
  });

// Every page shows these, so a move that didn't happen is seen wherever the person goes.
export const listMoveNotices = createServerFn({ method: "GET" }).handler(
  async (): Promise<MoveNotice[]> => {
    const person = await me();
    return noticesAcrossBoards(env.DB, person, async (boardId) =>
      (await moveNoticesOn(env, person.id, boardId)).list(),
    );
  },
);

export const dismissMoveNotice = createServerFn({ method: "POST" })
  .validator(parseMoveNoticeInput)
  .handler(async ({ data }): Promise<void> => {
    const person = await me();
    await (
      await moveNoticesOn(env, person.id, data.boardId)
    ).dismiss(data.moveId);
  });

export const searchTasks = createServerFn({ method: "GET" })
  .validator(parseSearchInput)
  .handler(async ({ data }): Promise<TaskSearchAnswer> => {
    const person = await me();
    const parsed = parseTaskSearch(data.text);
    if (!parsed.ok) return { status: "problem", problem: parsed.problem };
    return searchBoards(
      env.DB,
      person,
      (boardId) => openBoardFor(person.id, boardId),
      parsed.terms,
      data.place,
    );
  });

// Someone suspended still has their tasks shown, because the boards still hold them.
export const listPersonTasks = createServerFn({ method: "GET" })
  .validator(parsePersonInput)
  .handler(async ({ data }): Promise<PersonTasks> => {
    const person = await me();
    const them = await readColleague(env.DB, data.userId);
    if (!them) throw refusal(404, NO_PERSON_MESSAGE);
    return tasksOfPerson(
      env.DB,
      person,
      (boardId) => openBoardFor(person.id, boardId),
      them,
    );
  });

// Whether the task's assignee was emailed, for the panel.
export const assignmentEmail = createServerFn({ method: "GET" })
  .validator(parseTaskInput)
  .handler(async ({ data }): Promise<AssignmentEmailStatus> =>
    (await openBoardFor((await me()).id, data.boardId)).assignmentEmail(
      data.taskId,
    ),
  );

// Sends again only an email that didn't go, or may not have, from whoever chose it.
export const retryAssignmentEmail = createServerFn({ method: "POST" })
  .validator(parseTaskInput)
  .handler(async ({ data }): Promise<void> => {
    const board = await openBoardFor((await me()).id, data.boardId);
    const result = await board.retryAssignmentEmail(data.taskId);
    if (result === "noAccess") throw refusal(403, REFUSAL_MESSAGES.noAccess);
  });
