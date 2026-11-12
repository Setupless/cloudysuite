import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  ALICE,
  BOB,
  CAROL,
  create,
  createBoardTest,
  date,
  MARKETING,
  newTaskId,
} from "./test-support";
import {
  type ChangeResult,
  type ChecklistItemId,
  LIMITS,
  parsePlainDate,
  type Task,
  UNDO_DELETE_MS,
} from "./types";

let kit: ReturnType<typeof createBoardTest>;
const START = Date.parse("2026-11-12T09:00:00Z");

beforeEach(() => {
  setSystemTime(START);
  kit = createBoardTest();
});

afterEach(() => {
  setSystemTime();
});

function made(result: ChangeResult): Task {
  if (result.status !== "done")
    throw new Error(`expected a task: ${result.status}`);
  return result.task;
}

const refusal = (result: ChangeResult) =>
  result.status === "refused" ? result.message : null;

async function addTask(more: Parameters<typeof create>[1] = {}) {
  const id = newTaskId();
  made(await (await kit.as(ALICE)).change(create(id, more)));
  return id;
}

const item = (n: number) =>
  `00000000-0000-4000-9000-${String(n).padStart(12, "0")}` as ChecklistItemId;

test("a new task starts as To do with nobody assigned, and keeps who added it", async () => {
  const board = await kit.as(ALICE);
  const id = newTaskId();
  const task = made(
    await board.change(create(id, { title: "  Send the newsletter  " })),
  );
  expect(task).toEqual({
    id,
    title: "Send the newsletter",
    status: "todo",
    assignee: null,
    due: null,
    notes: "",
    checklist: [],
    createdBy: ALICE,
    createdAt: START,
    doneAt: null,
    moving: null,
  });
  expect(await board.listTasks()).toEqual([task]);
});

test("a create sent twice with the same id gives one task", async () => {
  const board = await kit.as(ALICE);
  const id = newTaskId();
  const first = made(await board.change(create(id)));
  const second = made(await board.change(create(id, { title: "Other" })));
  expect(second).toEqual(first);
  expect(await board.listTasks()).toHaveLength(1);
});

test("Can view sees every task but can't add, rename, or delete one", async () => {
  const id = await addTask();
  kit.join(BOB, "viewer");
  const bob = await kit.as(BOB);
  expect((await bob.listTasks()).map((task) => task.id)).toEqual([id]);
  for (const change of [
    create(newTaskId()),
    { kind: "rename", id, title: "Mine now" } as const,
    { kind: "delete", id } as const,
  ]) {
    expect(refusal(await bob.change(change))).toBe(
      "You can view this board but not change it. Ask one of its managers for Can edit.",
    );
  }
  expect((await bob.listTasks())[0]?.title).toBe("Send the newsletter");
  expect(await bob.listTasks()).toHaveLength(1);
});

test("Can view can change the status of their own task, but not its title or anyone else's", async () => {
  kit.join(BOB, "viewer");
  kit.join(CAROL, "editor");
  const bobs = await addTask({ assignee: BOB });
  const carols = await addTask({ assignee: CAROL });
  const nobodys = await addTask();
  const bob = await kit.as(BOB);

  const done = made(
    await bob.change({ kind: "setStatus", id: bobs, status: "done" }),
  );
  expect(done.status).toBe("done");
  expect(done.doneAt).toBe(START);

  for (const id of [carols, nobodys]) {
    expect(
      (await bob.change({ kind: "setStatus", id, status: "doing" })).status,
    ).toBe("refused");
  }
  expect(
    (await bob.change({ kind: "rename", id: bobs, title: "Renamed" })).status,
  ).toBe("refused");
  expect(
    (await bob.listTasks()).map((task) => [task.title, task.status]),
  ).toEqual([
    ["Send the newsletter", "done"],
    ["Send the newsletter", "todo"],
    ["Send the newsletter", "todo"],
  ]);
});

test("Can edit can assign anyone, and the assignee's name stays on the task", async () => {
  kit.join(CAROL, "editor");
  const id = await addTask();
  const carol = await kit.as(CAROL);
  const task = made(await carol.change({ kind: "assign", id, assignee: BOB }));
  expect(task.assignee).toEqual(BOB);
  kit.directory.run("DELETE FROM user WHERE id = ?", [BOB.id]);
  expect((await carol.findTask(id))?.assignee).toEqual(BOB);
  expect(
    made(await carol.change({ kind: "assign", id, assignee: null })).assignee,
  ).toBeNull();
});

test("a private task can't be assigned to anyone", async () => {
  const personal = await kit.personalBoardOf(ALICE);
  const board = await kit.as(ALICE, personal);
  expect(board.kind).toBe("personal");
  const id = newTaskId();
  const message =
    "Your private tasks are just for you, so they can't be assigned to anyone.";
  expect(refusal(await board.change(create(id, { assignee: BOB })))).toBe(
    message,
  );
  made(await board.change(create(id)));
  for (const assignee of [BOB, ALICE, null]) {
    expect(refusal(await board.change({ kind: "assign", id, assignee }))).toBe(
      message,
    );
  }
  expect((await board.findTask(id))?.assignee).toBeNull();
});

test("done is stamped when a task becomes done, kept when it's done again, and cleared when it leaves", async () => {
  const board = await kit.as(ALICE);
  const id = await addTask();
  made(await board.change({ kind: "setStatus", id, status: "doing" }));
  expect((await board.findTask(id))?.doneAt).toBeNull();
  made(await board.change({ kind: "setStatus", id, status: "done" }));
  setSystemTime(START + 60_000);
  const again = made(
    await board.change({ kind: "setStatus", id, status: "done" }),
  );
  expect(again.doneAt).toBe(START);
  const reopened = made(
    await board.change({ kind: "setStatus", id, status: "todo" }),
  );
  expect(reopened.doneAt).toBeNull();
});

test("a due date can be set and cleared, and only a real date parses", async () => {
  const board = await kit.as(ALICE);
  const id = await addTask({ due: date("2026-11-13") });
  expect((await board.findTask(id))?.due).toBe(date("2026-11-13"));
  expect(
    made(await board.change({ kind: "setDue", id, due: null })).due,
  ).toBeNull();
  expect(parsePlainDate("2028-02-29")).toBe(date("2028-02-29"));
  for (const raw of ["2026-02-30", "2026-13-01", "2026-1-01", "tomorrow"]) {
    expect([raw, parsePlainDate(raw)]).toEqual([raw, null]);
  }
});

test("each limit is refused in plain words", async () => {
  const board = await kit.as(ALICE);
  const id = await addTask();
  const long = (length: number) => "a".repeat(length);
  const cases: [Parameters<typeof board.change>[0], string][] = [
    [create(newTaskId(), { title: "   " }), "Give the task a title."],
    [
      create(newTaskId(), { title: long(LIMITS.title + 1) }),
      "A title can be up to 200 characters. Make it shorter.",
    ],
    [
      { kind: "rename", id, title: long(LIMITS.title + 1) },
      "A title can be up to 200 characters. Make it shorter.",
    ],
    [
      { kind: "setNotes", id, notes: long(LIMITS.notes + 1) },
      "Notes can be up to 10,000 characters. Make them shorter.",
    ],
    [
      { kind: "addItem", id, itemId: item(1), text: " " },
      "Give the checklist item some text.",
    ],
    [
      {
        kind: "addItem",
        id,
        itemId: item(1),
        text: long(LIMITS.checklistItem + 1),
      },
      "A checklist item can be up to 200 characters. Make it shorter.",
    ],
  ];
  for (const [change, message] of cases) {
    expect([change.kind, refusal(await board.change(change))]).toEqual([
      change.kind,
      message,
    ]);
  }
  // At each limit, it's taken.
  made(await board.change({ kind: "rename", id, title: long(LIMITS.title) }));
  made(await board.change({ kind: "setNotes", id, notes: long(LIMITS.notes) }));
  // An emoji is one character, as a person counts it.
  made(
    await board.change({
      kind: "rename",
      id,
      title: "🎉".repeat(LIMITS.title),
    }),
  );

  for (let n = 1; n <= LIMITS.checklistItems; n++) {
    made(
      await board.change({
        kind: "addItem",
        id,
        itemId: item(n),
        text: `Step ${n}`,
      }),
    );
  }
  expect(
    refusal(
      await board.change({
        kind: "addItem",
        id,
        itemId: item(99),
        text: "One more",
      }),
    ),
  ).toBe("A checklist can have up to 50 items. Remove one to add another.");
  expect((await board.findTask(id))?.checklist).toHaveLength(
    LIMITS.checklistItems,
  );
});

test("a checklist is added to, renamed, ticked, and removed from, and each is safe to repeat", async () => {
  const board = await kit.as(ALICE);
  const id = await addTask();
  const add = {
    kind: "addItem",
    id,
    itemId: item(1),
    text: " Draft copy ",
  } as const;
  made(await board.change(add));
  made(await board.change(add));
  made(
    await board.change({
      kind: "addItem",
      id,
      itemId: item(2),
      text: "Proofread",
    }),
  );
  made(
    await board.change({
      kind: "renameItem",
      id,
      itemId: item(1),
      text: "Draft the copy",
    }),
  );
  for (let time = 0; time < 2; time++) {
    made(
      await board.change({
        kind: "toggleItem",
        id,
        itemId: item(1),
        done: true,
      }),
    );
  }
  expect((await board.findTask(id))?.checklist).toEqual([
    { id: item(1), text: "Draft the copy", done: true },
    { id: item(2), text: "Proofread", done: false },
  ]);
  for (let time = 0; time < 2; time++) {
    made(await board.change({ kind: "removeItem", id, itemId: item(2) }));
  }
  expect(
    refusal(
      await board.change({
        kind: "toggleItem",
        id,
        itemId: item(2),
        done: true,
      }),
    ),
  ).toBe("That checklist item has been removed.");
  expect((await board.findTask(id))?.checklist).toEqual([
    { id: item(1), text: "Draft the copy", done: true },
  ]);
});

test("delete then undo restores the task, and a delete sent twice keeps its first Undo time", async () => {
  const board = await kit.as(ALICE);
  const id = await addTask({ assignee: BOB });
  const before = await board.findTask(id);
  expect(await board.change({ kind: "delete", id })).toEqual({
    status: "deleted",
    undoUntil: START + UNDO_DELETE_MS,
  });
  expect(await board.listTasks()).toEqual([]);
  expect(await board.findTask(id)).toBeNull();
  expect(refusal(await board.change({ kind: "rename", id, title: "x" }))).toBe(
    "That task has been deleted.",
  );
  setSystemTime(START + 5_000);
  expect(await board.change({ kind: "delete", id })).toEqual({
    status: "deleted",
    undoUntil: START + UNDO_DELETE_MS,
  });
  expect(made(await board.change({ kind: "undoDelete", id }))).toEqual(before!);
  expect(made(await board.change({ kind: "undoDelete", id }))).toEqual(before!);
  expect(await board.listTasks()).toEqual([before!]);
  expect(kit.alarmOf(MARKETING)).toBeNull();
});

test("after Undo has passed the alarm deletes the task for good, and running it again changes nothing", async () => {
  const board = await kit.as(ALICE);
  const gone = await addTask();
  const kept = await addTask();
  await board.change({ kind: "delete", id: gone });
  expect(kit.alarmOf(MARKETING)).toBe(START + UNDO_DELETE_MS);

  setSystemTime(START + UNDO_DELETE_MS);
  expect(refusal(await board.change({ kind: "undoDelete", id: gone }))).toBe(
    "It's too late to undo. The task has been deleted.",
  );
  await kit.runAlarm(MARKETING);
  expect(kit.alarmOf(MARKETING)).toBeNull();
  await kit.runAlarm(MARKETING);
  expect((await board.listTasks()).map((task) => task.id)).toEqual([kept]);
  expect(refusal(await board.change({ kind: "undoDelete", id: gone }))).toBe(
    "It's too late to undo. The task has been deleted.",
  );
});

test("an alarm that runs before a later delete's Undo has passed leaves that task", async () => {
  const board = await kit.as(ALICE);
  const first = await addTask();
  const second = await addTask();
  await board.change({ kind: "delete", id: first });
  setSystemTime(START + 4_000);
  await board.change({ kind: "delete", id: second });
  setSystemTime(START + UNDO_DELETE_MS);
  await kit.runAlarm(MARKETING);
  expect(kit.alarmOf(MARKETING)).toBe(START + 4_000 + UNDO_DELETE_MS);
  made(await board.change({ kind: "undoDelete", id: second }));
  expect((await board.listTasks()).map((task) => task.id)).toEqual([second]);
});

test("someone not on a board, or suspended, can't open it", async () => {
  expect(await kit.as(BOB).catch((error: Error) => error.message)).toBe(
    "expected access",
  );
  kit.directory.run("UPDATE user SET banned = 1 WHERE id = ?", [ALICE.id]);
  expect(await kit.as(ALICE).catch((error: Error) => error.message)).toBe(
    "expected access",
  );
});

test("a task id is a task on one board only", async () => {
  const id = await addTask();
  const personal = await kit.as(ALICE, await kit.personalBoardOf(ALICE));
  expect(await personal.findTask(id)).toBeNull();
  expect(refusal(await personal.change({ kind: "delete", id }))).toBe(
    "That task has been deleted.",
  );
});
