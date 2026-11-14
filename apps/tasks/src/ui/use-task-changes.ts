import type { BoardId, UserId } from "@cloudysuite/access";
import { useToast } from "@cloudysuite/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  addAndAssign,
  changeTask,
  createPrivateTask,
  moveTask,
} from "../functions";
import { call, tasksKeys } from "../queries";
import type {
  BoardOfTask,
  BoardTasks,
  MoveTarget,
  MyTask,
  MyTasks,
  NewPrivateTask,
  PersonTasks,
  Task,
  TaskChangeInput,
  TaskHit,
  TaskId,
  TaskStatus,
} from "../types";

const withTask = (tasks: Task[], task: Task) =>
  tasks.some((shown) => shown.id === task.id)
    ? tasks.map((shown) => (shown.id === task.id ? task : shown))
    : [...tasks, task];

// Sends each change, then shows the task the server answered with wherever it appears,
// so the page needn't ask every board again.
export function useTaskChanges() {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  function put(boardId: BoardId, task: Task) {
    client.setQueryData<BoardTasks>(tasksKeys.board(boardId), (shown) =>
      shown ? { ...shown, tasks: withTask(shown.tasks, task) } : shown,
    );
    const replace = <Shown extends { tasks: TaskHit[] }>(shown?: Shown) =>
      shown
        ? {
            ...shown,
            tasks: shown.tasks.map((hit) =>
              hit.id === task.id ? { ...task, board: hit.board } : hit,
            ),
          }
        : shown;
    client.setQueryData<MyTasks>(tasksKeys.mine, replace);
    client.setQueriesData<PersonTasks>({ queryKey: tasksKeys.people }, replace);
  }

  function drop(boardId: BoardId, id: TaskId) {
    client.setQueryData<BoardTasks>(tasksKeys.board(boardId), (shown) =>
      shown
        ? { ...shown, tasks: shown.tasks.filter((task) => task.id !== id) }
        : shown,
    );
    client.setQueryData<MyTasks>(tasksKeys.mine, (shown) =>
      shown
        ? { ...shown, tasks: shown.tasks.filter((task) => task.id !== id) }
        : shown,
    );
  }

  function addMine(task: MyTask) {
    client.setQueryData<MyTasks>(tasksKeys.mine, (shown) =>
      shown ? { ...shown, tasks: [...shown.tasks, task] } : shown,
    );
  }

  const failed = async (failure: unknown) => {
    toast({ tone: "danger", message: (failure as Error).message });
    await client.invalidateQueries({ queryKey: tasksKeys.all });
  };

  // Resolves with the saved task, or null once the person has been told why not.
  async function send(
    boardId: BoardId,
    change: TaskChangeInput,
  ): Promise<Task | null> {
    try {
      const answer = await call(() =>
        changeTask({ data: { boardId, change } }),
      );
      if (answer.status !== "done") return null;
      put(boardId, answer.task);
      return answer.task;
    } catch (failure) {
      await failed(failure);
      return null;
    }
  }

  // The circle and the panel's status answer at once, and the server catches up.
  async function setStatus(boardId: BoardId, task: Task, status: TaskStatus) {
    put(boardId, {
      ...task,
      status,
      doneAt: status === "done" ? (task.doneAt ?? Date.now()) : null,
    });
    return send(boardId, { kind: "setStatus", id: task.id, status });
  }

  async function tick(boardId: BoardId, task: Task) {
    const before = task.status;
    const after = before === "done" ? "todo" : "done";
    if (!(await setStatus(boardId, task, after))) return;
    toast({
      message:
        after === "done"
          ? `"${task.title}" is done.`
          : `"${task.title}" is back in To do.`,
      action: {
        label: "Undo",
        run: () => void setStatus(boardId, { ...task, status: after }, before),
      },
    });
  }

  async function remove(boardId: BoardId, task: Task) {
    try {
      const answer = await call(() =>
        changeTask({
          data: { boardId, change: { kind: "delete", id: task.id } },
        }),
      );
      drop(boardId, task.id);
      if (answer.status !== "deleted") return;
      toast({
        message: `"${task.title}" was deleted.`,
        durationMs: Math.max(0, answer.undoUntil - Date.now()),
        action: {
          label: "Undo",
          run: () => void undoRemove(boardId, task),
        },
      });
    } catch (failure) {
      await failed(failure);
    }
  }

  async function undoRemove(boardId: BoardId, task: Task) {
    const restored = await send(boardId, { kind: "undoDelete", id: task.id });
    if (!restored) return;
    if (client.getQueryData<MyTasks>(tasksKeys.mine)) {
      await client.invalidateQueries({ queryKey: tasksKeys.mine });
    }
  }

  async function addPrivate(task: NewPrivateTask): Promise<boolean> {
    try {
      addMine(await call(() => createPrivateTask({ data: task })));
      return true;
    } catch (failure) {
      toast({ tone: "danger", message: (failure as Error).message });
      return false;
    }
  }

  // Throws with the words to show, so the dialog that asked can say what went wrong.
  async function addAndAssignTo(
    boardId: BoardId,
    taskId: TaskId,
    userId: UserId,
  ): Promise<void> {
    const answer = await call(() =>
      addAndAssign({ data: { boardId, taskId, userId } }),
    );
    if (answer.status === "done") put(boardId, answer.task);
    await client.invalidateQueries({ queryKey: tasksKeys.settings(boardId) });
  }

  // Throws with the words to show, so the move dialog can say why the task stayed.
  async function move(
    boardId: BoardId,
    task: Task,
    target: MoveTarget,
  ): Promise<void> {
    const answer = await call(() =>
      moveTask({ data: { boardId, taskId: task.id, to: target } }),
    );
    const name = placeName(answer.to);
    if (answer.status === "moving") {
      await client.invalidateQueries({ queryKey: tasksKeys.board(boardId) });
      await client.invalidateQueries({ queryKey: tasksKeys.mine });
      toast({
        message: `The task is on its way to ${name}. It will finish moving by itself.`,
      });
      return;
    }
    client.setQueryData<BoardTasks>(tasksKeys.board(boardId), (shown) =>
      shown
        ? { ...shown, tasks: shown.tasks.filter((t) => t.id !== task.id) }
        : shown,
    );
    void client.invalidateQueries({ queryKey: tasksKeys.mine });
    void client.invalidateQueries({ queryKey: tasksKeys.board(answer.to.id) });
    toast({
      message: `Moved to ${name}`,
      action: {
        label: "Show",
        run: () =>
          void (answer.to.kind === "personal"
            ? navigate({ to: "/tasks", search: { task: task.id } })
            : navigate({
                to: "/tasks/boards/$boardId",
                params: { boardId: answer.to.id },
                search: { task: task.id },
              })),
      },
    });
  }

  return { send, setStatus, tick, remove, addPrivate, addAndAssignTo, move };
}

const placeName = (board: BoardOfTask) =>
  board.kind === "personal" ? "your private tasks" : board.name;
