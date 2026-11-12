import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import type { BoardId } from "@cloudysuite/access";
import type { BoardClient } from "./client";
import type { MoveDelivery } from "./moves";
import type { Actor } from "./store";
import {
  ALICE,
  BOB,
  create,
  createBoardTest,
  MARKETING,
  newTaskId,
  PRODUCT,
} from "./test-support";
import type { MoveOutcome, Task, TaskId } from "./types";

let kit: ReturnType<typeof createBoardTest>;
let quiet: ReturnType<typeof spyOn>;
const START = Date.parse("2026-11-12T09:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  setSystemTime(START);
  kit = createBoardTest();
  // Each failed step says so, and these tests fail steps on purpose.
  quiet = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setSystemTime();
  quiet.mockRestore();
});

type MoveDetails = Parameters<BoardClient["moveTo"]>[2];

const TO_PRODUCT: MoveDetails = {
  to: { kind: "team", name: "Product" },
  keepAssigneeId: null,
};

async function addTask(boardId: BoardId = MARKETING) {
  const id = newTaskId();
  const result = await (await kit.as(ALICE, boardId)).change(create(id));
  if (result.status !== "done") throw new Error("expected a task");
  return id;
}

async function move(
  id: TaskId,
  from: BoardId = MARKETING,
  to: BoardId = PRODUCT,
  more: MoveDetails = TO_PRODUCT,
): Promise<MoveOutcome> {
  return (await kit.as(ALICE, from)).moveTo(id, await kit.as(ALICE, to), more);
}

const shown = async (boardId: BoardId) =>
  (await (await kit.as(ALICE, boardId)).listTasks()).map((task) => ({
    id: task.id,
    title: task.title,
    moving: task.moving?.name ?? null,
  }));

const lastDelivery = (): [Actor, MoveDelivery] => {
  const calls = kit.callsTo(PRODUCT, "receiveMove");
  const last = calls.at(-1);
  if (!last) throw new Error("expected a delivery");
  return last.args as [Actor, MoveDelivery];
};

// Runs a board's alarm once the retry is due.
async function laterAlarm(boardId: BoardId, after = MINUTE) {
  setSystemTime(Date.now() + after);
  await kit.runAlarm(boardId);
}

test("a move leaves exactly one task, on the other board, and nothing left to do", async () => {
  const id = await addTask();
  expect(await move(id)).toEqual({ status: "moved" });
  expect(await shown(MARKETING)).toEqual([]);
  expect(await shown(PRODUCT)).toEqual([
    { id, title: "Send the newsletter", moving: null },
  ]);
  expect(kit.alarmOf(MARKETING)).toBeNull();
  expect(kit.alarmOf(PRODUCT)).toBeNull();
});

test("a task moved into a private board arrives with nobody assigned", async () => {
  kit.join(BOB, "editor");
  const id = newTaskId();
  await (
    await kit.as(ALICE)
  ).change(create(id, { assignee: { id: BOB.id, name: BOB.name } }));
  const mine = await kit.personalBoardOf(ALICE);
  expect(
    await move(id, MARKETING, mine, {
      to: { kind: "personal", name: ALICE.name },
      keepAssigneeId: BOB.id,
    }),
  ).toEqual({ status: "moved" });
  const [task] = await (await kit.as(ALICE, mine)).listTasks();
  expect(task?.assignee).toBeNull();
});

test("every receiving step can be repeated, in any order, and changes nothing", async () => {
  const id = await addTask();
  kit.fail(PRODUCT, "unlockMoveIn", "silent");
  expect(await move(id)).toEqual({ status: "moved" });
  const [actor, delivery] = lastDelivery();
  const receiver = kit.objectOf(PRODUCT);
  // Locked and not shown, whatever is repeated.
  for (const step of [
    () => receiver.receiveMove(actor, delivery),
    () => receiver.receiveMove(actor, delivery),
  ]) {
    expect(step()).toEqual({ status: "added" });
    expect(await shown(PRODUCT)).toEqual([]);
  }
  receiver.unlockMoveIn(delivery.moveId);
  receiver.unlockMoveIn(delivery.moveId);
  expect(receiver.receiveMove(actor, delivery)).toEqual({ status: "added" });
  // The sender already kept nothing, so a drop now is a late repeat of a step that
  // never applied, and the task stays.
  receiver.dropMoveIn(delivery.moveId);
  expect(await shown(PRODUCT)).toEqual([
    { id, title: "Send the newsletter", moving: null },
  ]);

  kit.fail(PRODUCT, "unlockMoveIn", null);
  await laterAlarm(MARKETING);
  await laterAlarm(MARKETING);
  expect(await shown(MARKETING)).toEqual([]);
  expect(await shown(PRODUCT)).toHaveLength(1);
});

test("a drop that arrives before the delivery means the delivery adds nothing", async () => {
  const id = await addTask();
  kit.fail(PRODUCT, "unlockMoveIn", "silent");
  await move(id);
  const [actor, delivery] = lastDelivery();
  const elsewhere = { ...delivery, moveId: crypto.randomUUID() };
  const receiver = kit.objectOf(PRODUCT);
  receiver.dropMoveIn(elsewhere.moveId);
  expect(receiver.receiveMove(actor, elsewhere)).toEqual({
    status: "refused",
    reason: "dropped",
  });
  receiver.unlockMoveIn(elsewhere.moveId);
  receiver.dropMoveIn(elsewhere.moveId);
  expect(receiver.receiveMove(actor, elsewhere)).toEqual({
    status: "refused",
    reason: "dropped",
  });
});

test("a crash after the receiver added its copy, before the sender deleted its own, ends with one task", async () => {
  const id = await addTask();
  kit.fail(PRODUCT, "receiveMove", "loseAnswer");
  expect(await move(id)).toEqual({ status: "pending" });
  expect(await shown(MARKETING)).toEqual([
    { id, title: "Send the newsletter", moving: "Product" },
  ]);
  expect(await shown(PRODUCT)).toEqual([]);
  expect(kit.alarmOf(MARKETING)).toBe(Date.now() + MINUTE);

  kit.fail(PRODUCT, "receiveMove", null);
  await laterAlarm(MARKETING);
  expect(await shown(MARKETING)).toEqual([]);
  expect(await shown(PRODUCT)).toEqual([
    { id, title: "Send the newsletter", moving: null },
  ]);
  expect(kit.alarmOf(MARKETING)).toBeNull();
});

test("a crash after the sender deleted its own task is finished by the alarm", async () => {
  const id = await addTask();
  kit.fail(PRODUCT, "unlockMoveIn", "silent");
  expect(await move(id)).toEqual({ status: "moved" });
  expect(await shown(MARKETING)).toEqual([]);
  expect(await shown(PRODUCT)).toEqual([]);
  kit.fail(PRODUCT, "unlockMoveIn", null);
  await laterAlarm(MARKETING);
  expect(await shown(PRODUCT)).toHaveLength(1);
  expect(kit.alarmOf(MARKETING)).toBeNull();
});

test("a receiver that refuses unlocks the sender at once", async () => {
  kit.directory.run(
    "UPDATE board_access SET role = 'viewer' WHERE board_id = ? AND user_id = ?",
    [PRODUCT, ALICE.id],
  );
  const id = await addTask();
  expect(await move(id)).toEqual({
    status: "refusedThere",
    reason: "noAccess",
  });
  expect(await shown(MARKETING)).toEqual([
    { id, title: "Send the newsletter", moving: null },
  ]);
  expect(kit.alarmOf(MARKETING)).toBeNull();
});

test("losing Can edit, or the board, while the move waits refuses it from the alarm", async () => {
  for (const takeAway of [
    () =>
      kit.directory.run(
        "UPDATE board_access SET role = 'viewer' WHERE board_id = ?",
        [PRODUCT],
      ),
    () => kit.directory.run("DELETE FROM boards WHERE id = ?", [PRODUCT]),
  ]) {
    kit = createBoardTest();
    setSystemTime(START);
    const id = await addTask();
    kit.fail(PRODUCT, "receiveMove", "silent");
    expect(await move(id)).toEqual({ status: "pending" });
    takeAway();
    kit.fail(PRODUCT, "receiveMove", null);
    await laterAlarm(MARKETING);
    expect(await shown(MARKETING)).toEqual([
      { id, title: "Send the newsletter", moving: null },
    ]);
    expect(kit.alarmOf(MARKETING)).toBeNull();
  }
});

test("a receiver silent for an hour leaves the task with the sender, and its copy is dropped when it's back", async () => {
  const id = await addTask();
  // It adds a copy each time, and the sender never hears.
  kit.fail(PRODUCT, "receiveMove", "loseAnswer");
  expect(await move(id)).toEqual({ status: "pending" });
  await laterAlarm(MARKETING, 30 * MINUTE);
  expect(await shown(MARKETING)).toEqual([
    { id, title: "Send the newsletter", moving: "Product" },
  ]);
  kit.fail(PRODUCT, "dropMoveIn", "silent");
  await laterAlarm(MARKETING, 31 * MINUTE);
  expect(await shown(MARKETING)).toEqual([
    { id, title: "Send the newsletter", moving: null },
  ]);
  expect(await shown(PRODUCT)).toEqual([]);
  // The sender can change its task again, while it keeps telling the receiver.
  await (await kit.as(ALICE)).change({ kind: "rename", id, title: "Kept" });
  await laterAlarm(MARKETING);
  expect(kit.alarmOf(MARKETING)).not.toBeNull();

  kit.fail(PRODUCT, "receiveMove", null);
  kit.fail(PRODUCT, "dropMoveIn", null);
  await laterAlarm(MARKETING);
  expect(kit.callsTo(PRODUCT, "dropMoveIn")).toHaveLength(1);
  expect(kit.alarmOf(MARKETING)).toBeNull();
  const [actor, delivery] = lastDelivery();
  expect(kit.objectOf(PRODUCT).receiveMove(actor, delivery)).toEqual({
    status: "refused",
    reason: "dropped",
  });
  kit.objectOf(PRODUCT).unlockMoveIn(delivery.moveId);
  expect(await shown(PRODUCT)).toEqual([]);
  expect(await shown(MARKETING)).toEqual([{ id, title: "Kept", moving: null }]);
});

test("a late repeat of a finished move adds nothing", async () => {
  const id = await addTask();
  await move(id);
  const [actor, delivery] = lastDelivery();
  await (
    await kit.as(ALICE, PRODUCT)
  ).change({ kind: "rename", id, title: "Changed there" });
  expect(kit.objectOf(PRODUCT).receiveMove(actor, delivery)).toEqual({
    status: "added",
  });
  kit.objectOf(PRODUCT).unlockMoveIn(delivery.moveId);
  expect(await shown(PRODUCT)).toEqual([
    { id, title: "Changed there", moving: null },
  ]);
});

test("a task moved away and back can move again", async () => {
  const id = await addTask();
  expect(await move(id)).toEqual({ status: "moved" });
  expect(
    await move(id, PRODUCT, MARKETING, {
      to: { kind: "team", name: "Marketing" },
      keepAssigneeId: null,
    }),
  ).toEqual({ status: "moved" });
  expect(await move(id)).toEqual({ status: "moved" });
  expect(await shown(MARKETING)).toEqual([]);
  expect(await shown(PRODUCT)).toHaveLength(1);
});

test("a locked task can't be renamed, ticked, moved, or deleted, on either board", async () => {
  kit.join(BOB, "viewer");
  const id = newTaskId();
  await (
    await kit.as(ALICE)
  ).change(create(id, { assignee: { id: BOB.id, name: BOB.name } }));
  kit.fail(PRODUCT, "receiveMove", "loseAnswer");
  expect(await move(id)).toEqual({ status: "pending" });
  const moving = (result: { status: string; reason?: string }) =>
    result.status === "refused" ? result.reason : result.status;

  const sender = await kit.as(ALICE);
  for (const change of [
    { kind: "rename", id, title: "Other" },
    { kind: "setStatus", id, status: "done" },
    { kind: "delete", id },
  ] as const) {
    expect(moving(await sender.change(change))).toBe("moving");
  }
  // An assignee with Can view may tick their own task, but not while it moves.
  expect(
    moving(
      await (
        await kit.as(BOB)
      ).change({ kind: "setStatus", id, status: "done" }),
    ),
  ).toBe("moving");
  expect(moving(await move(id))).toBe("moving");

  // The receiver's locked copy can't be reached by its id either.
  const receiver = await kit.as(ALICE, PRODUCT);
  expect(moving(await receiver.change(create(id)))).toBe("moving");
  expect(
    moving(await receiver.change({ kind: "rename", id, title: "Other" })),
  ).toBe("moving");
  expect(await receiver.findTask(id)).toBeNull();
});

test("a task in its Undo time can't be moved", async () => {
  const id = await addTask();
  await (await kit.as(ALICE)).change({ kind: "delete", id });
  expect(await move(id)).toMatchObject({ status: "refused", reason: "gone" });
});

test("Can view on the sending board can't move a task", async () => {
  kit.join(BOB, "viewer");
  kit.join(BOB, "manager", PRODUCT);
  const id = await addTask();
  const outcome = await (
    await kit.as(BOB)
  ).moveTo(id, await kit.as(BOB, PRODUCT), TO_PRODUCT);
  expect(outcome).toMatchObject({ status: "refused", reason: "noAccess" });
  expect(await shown(MARKETING)).toHaveLength(1);
});

test("an assignee the server function kept stays assigned", async () => {
  kit.join(BOB, "editor");
  const id = newTaskId();
  await (
    await kit.as(ALICE)
  ).change(create(id, { assignee: { id: BOB.id, name: BOB.name } }));
  await move(id, MARKETING, PRODUCT, {
    to: { kind: "team", name: "Product" },
    keepAssigneeId: BOB.id,
  });
  const [task] = (await (await kit.as(ALICE, PRODUCT)).listTasks()) as Task[];
  expect(task?.assignee).toEqual(BOB);
});

test("a board deleted while a task arrives drops the copy, and nothing is left behind", async () => {
  const id = await addTask();
  kit.fail(PRODUCT, "unlockMoveIn", "silent");
  await move(id);
  expect(await (await kit.as(ALICE, PRODUCT)).erase()).toBe("done");
  kit.fail(PRODUCT, "unlockMoveIn", null);
  await laterAlarm(MARKETING);
  expect(kit.alarmOf(MARKETING)).toBeNull();
  expect(await shown(PRODUCT)).toEqual([]);
});
