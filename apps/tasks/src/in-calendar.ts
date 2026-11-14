import { env } from "cloudflare:workers";
import type { BoardId, UserId } from "@cloudysuite/access";
import { isAppOff } from "../../../src/app-on";
import { openBoardFor } from "./access";
import { dueTasksOf } from "./due";
import {
  type DueRange,
  type DueTasks,
  TASKS_OFF_IN_CALENDAR_MESSAGE,
  type TaskId,
  type TaskStatus,
} from "./types";
import { refusal } from "./wire";

export type {
  BoardOfTask,
  DueRange,
  DueTask,
  DueTasks,
  PlainDate,
  TaskId,
  TaskStatus,
} from "./types";
export { parseDueRangeInput, parseStatusInput } from "./wire";

// Calendar calls these once it has checked that Calendar is on and who is signed in.
// Each checks that Tasks is on as well, because a server function answers on every
// app's hostname.

type Person = { id: UserId; name: string };

export async function readDueTasks(
  person: Person,
  range: DueRange,
): Promise<DueTasks> {
  if (await isAppOff(env.DB, "tasks")) return { status: "off" };
  return dueTasksOf(
    env.DB,
    person,
    (boardId) => openBoardFor(person.id, boardId),
    range,
  );
}

// The Board object applies its own rules, so Can view still ticks off only their own.
export async function setStatusFromCalendar(
  person: Person,
  input: { boardId: BoardId; taskId: TaskId; status: TaskStatus },
): Promise<void> {
  if (await isAppOff(env.DB, "tasks")) {
    throw refusal(403, TASKS_OFF_IN_CALENDAR_MESSAGE);
  }
  const board = await openBoardFor(person.id, input.boardId);
  const result = await board.change({
    kind: "setStatus",
    id: input.taskId,
    status: input.status,
  });
  if (result.status === "refused") {
    throw refusal(result.reason === "noAccess" ? 403 : 409, result.message);
  }
}
