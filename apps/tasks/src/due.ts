import type { UserId } from "@cloudysuite/access";
import { askEach } from "@cloudysuite/search";
import { readMyBoards } from "./directory";
import { bySoonestDue } from "./order";
import type { OpenBoard } from "./search";
import type {
  BoardEntry,
  BoardOfTask,
  DueRange,
  DueTask,
  DueTasks,
  PlainDate,
  Task,
} from "./types";

// Where the task opens with its panel. A private task is on My tasks, and a team task on
// its board, as search opens them.
const pathOf = (task: Task, board: BoardOfTask) =>
  board.kind === "personal"
    ? `/?task=${task.id}`
    : `/boards/${board.id}?task=${task.id}`;

const boardOf = ({ role: _role, ...board }: BoardEntry): BoardOfTask => board;

// The person's own open tasks due in the range, on every board they're on, soonest
// first. On a team board that's only what's assigned to them, never a colleague's.
export async function dueTasksOf(
  database: D1Database,
  person: { id: UserId; name: string },
  open: OpenBoard,
  range: DueRange,
): Promise<Extract<DueTasks, { status: "listed" }>> {
  const { answers, missing } = await askEach(
    await readMyBoards(database, person),
    async (entry) => {
      const tasks = await (await open(entry.id)).listMyTasksDue(range);
      const board = boardOf(entry);
      return tasks.map((task) => ({ task, board }));
    },
  );
  const tasks = answers
    .flat()
    .sort((one, other) => bySoonestDue(one.task, other.task))
    .map(({ task, board }): DueTask => ({
      id: task.id,
      title: task.title,
      status: task.status as DueTask["status"],
      due: task.due as PlainDate,
      board,
      path: pathOf(task, board),
    }));
  return { status: "listed", tasks, unreachable: missing };
}
