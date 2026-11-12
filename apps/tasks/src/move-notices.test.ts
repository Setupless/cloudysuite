import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import type { BoardId } from "@cloudysuite/access";
import { applyMigrations } from "@cloudysuite/object-sql";
import { moveNoticesOn } from "./client";
import { MIGRATIONS } from "./migrations";
import { noticesAcrossBoards } from "./move-notices";
import { TaskStore } from "./store";
import {
  ALICE,
  BOB,
  create,
  createBoardTest,
  MARKETING,
  newTaskId,
  PRODUCT,
} from "./test-support";
import type { MoveNotice, Person, TaskId } from "./types";

let kit: ReturnType<typeof createBoardTest>;
let quiet: ReturnType<typeof spyOn>;
const START = Date.parse("2026-11-12T09:00:00Z");
const MINUTE = 60_000;

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

async function addTask(title = "Plan the launch party") {
  const id = newTaskId();
  await (await kit.as(ALICE)).change(create(id, { title }));
  return id;
}

const move = async (id: TaskId) =>
  (await kit.as(ALICE)).moveTo(id, await kit.as(ALICE, PRODUCT), {
    to: { kind: "team", name: "Product" },
    keepAssigneeId: null,
  });

async function laterAlarm(boardId: BoardId = MARKETING, after = MINUTE) {
  setSystemTime(Date.now() + after);
  await kit.runAlarm(boardId);
}

// Which boards a page woke to show this person their notes.
let asked: BoardId[] = [];
async function notesFor(person: Person = ALICE): Promise<MoveNotice[]> {
  asked = [];
  return noticesAcrossBoards(kit.env.DB, person, async (boardId) => {
    asked.push(boardId);
    return (await moveNoticesOn(kit.env, person.id, boardId)).list();
  });
}

const dismiss = async (person: Person, moveId: string) =>
  (await moveNoticesOn(kit.env, person.id, MARKETING)).dismiss(moveId);

const loseCanEditOnProduct = () =>
  kit.directory.run(
    "UPDATE board_access SET role = 'viewer' WHERE board_id = ? AND user_id = ?",
    [PRODUCT, ALICE.id],
  );

const MARKETING_BOARD = {
  id: MARKETING,
  kind: "team",
  name: "Marketing",
  colour: 2,
} as const;

// The person was told it's on its way, then the other board refused it from the alarm.
async function refusedLater() {
  const id = await addTask();
  kit.fail(PRODUCT, "receiveMove", "silent");
  expect(await move(id)).toEqual({ status: "pending" });
  loseCanEditOnProduct();
  kit.fail(PRODUCT, "receiveMove", null);
  await laterAlarm();
  return id;
}

test("a move refused after the person was told it's on its way leaves them one note", async () => {
  await refusedLater();
  expect(await notesFor()).toEqual([
    {
      boardId: MARKETING,
      moveId: expect.any(String),
      task: { title: "Plan the launch party", stillOn: MARKETING_BOARD },
      to: { kind: "team", name: "Product" },
      setback: "noAccess",
      notedAt: START + MINUTE,
    },
  ]);
  expect(asked).toEqual([MARKETING]);
});

test("a refusal the person waits for shows in the dialog and leaves no note", async () => {
  loseCanEditOnProduct();
  const id = await addTask();
  expect(await move(id)).toEqual({
    status: "refusedThere",
    reason: "noAccess",
  });
  expect(await notesFor()).toEqual([]);
});

test("a move given up after an hour leaves one note, and its late repeats add none", async () => {
  const id = await addTask();
  kit.fail(PRODUCT, "receiveMove", "silent");
  expect(await move(id)).toEqual({ status: "pending" });
  await laterAlarm(MARKETING, 30 * MINUTE);
  expect(await notesFor()).toEqual([]);

  kit.fail(PRODUCT, "dropMoveIn", "silent");
  await laterAlarm(MARKETING, 31 * MINUTE);
  const told = await notesFor();
  expect(told).toMatchObject([
    {
      task: { title: "Plan the launch party" },
      setback: "noAnswer",
    },
  ]);
  // The alarm keeps telling Product to drop its copy, and writes no second note.
  await laterAlarm();
  kit.fail(PRODUCT, "dropMoveIn", null);
  await laterAlarm();
  expect(await notesFor()).toEqual(told);
  expect(kit.alarmOf(MARKETING)).toBeNull();
  expect(await (await kit.as(ALICE)).findTask(id)).toMatchObject({
    moving: null,
  });
});

test("only the person who moved it sees the note, and only they can dismiss it", async () => {
  kit.join(BOB, "editor");
  await refusedLater();
  const [note] = await notesFor();
  if (!note) throw new Error("expected a note");
  expect(await notesFor(BOB)).toEqual([]);
  expect(asked).toEqual([]);

  await dismiss(BOB, note.moveId);
  expect(await notesFor()).toEqual([note]);

  await dismiss(ALICE, note.moveId);
  await dismiss(ALICE, note.moveId);
  expect(await notesFor()).toEqual([]);
  expect(asked).toEqual([]);
  expect(kit.alarmOf(MARKETING)).toBeNull();
});

test("once the person can't open the board the task stayed on, the note leaves out its name", async () => {
  await refusedLater();
  kit.directory.run(
    "DELETE FROM board_access WHERE board_id = ? AND user_id = ?",
    [MARKETING, ALICE.id],
  );
  const [note, ...others] = await notesFor();
  expect(others).toEqual([]);
  expect(note).toMatchObject({ boardId: MARKETING, task: null });
  await dismiss(ALICE, note?.moveId as string);
  expect(await notesFor()).toEqual([]);
});

test("with nothing to tell, no board is woken to find out", async () => {
  const id = await addTask();
  expect(await move(id)).toEqual({ status: "moved" });
  expect(await notesFor()).toEqual([]);
  expect(asked).toEqual([]);
});

test("a note D1 couldn't be told about arrives once the alarm tries again, and so does its dismissal", async () => {
  kit.d1Failures.moveNotices = true;
  await refusedLater();
  expect(await notesFor()).toEqual([]);
  expect(kit.alarmOf(MARKETING)).toBe(Date.now() + MINUTE);

  kit.d1Failures.moveNotices = false;
  await laterAlarm();
  const [note] = await notesFor();
  expect(note).toMatchObject({ setback: "noAccess" });
  expect(asked).toEqual([MARKETING]);
  expect(kit.alarmOf(MARKETING)).toBeNull();

  kit.d1Failures.moveNotices = true;
  await dismiss(ALICE, note?.moveId as string);
  kit.d1Failures.moveNotices = false;
  expect(await notesFor()).toEqual([]);
  expect(asked).toEqual([MARKETING]);
  await laterAlarm();
  expect(await notesFor()).toEqual([]);
  expect(asked).toEqual([]);
  expect(kit.alarmOf(MARKETING)).toBeNull();
});

test("a deleted board takes its notes with it", async () => {
  await refusedLater();
  kit.directory.run("DELETE FROM boards WHERE id = ?", [MARKETING]);
  expect(await notesFor()).toEqual([]);
  expect(asked).toEqual([]);
});

// Marketing's storage as the release before notes left it, with a move still on its way.
function movingBeforeNotes() {
  const id = newTaskId();
  kit.seedStorage(MARKETING, (db) => {
    applyMigrations(db, MIGRATIONS.slice(0, -1));
    const store = new TaskStore(db);
    const actor = {
      userId: ALICE.id,
      boardId: MARKETING,
      role: "manager",
      kind: "team",
    } as const;
    store.change(actor, create(id, { title: "Plan the launch party" }), START);
    store.beginMoveOut(actor, {
      moveId: crypto.randomUUID(),
      id,
      toBoardId: PRODUCT,
      to: { kind: "team", name: "Product" },
      keepAssigneeId: null,
      tryAt: START + MINUTE,
      giveUpAt: START + 60 * MINUTE,
    });
  });
  return id;
}

test("a move already on its way when notes began leaves one note when it's refused", async () => {
  movingBeforeNotes();
  loseCanEditOnProduct();
  await laterAlarm();
  await laterAlarm();
  expect(await notesFor()).toEqual([
    {
      boardId: MARKETING,
      moveId: expect.any(String),
      task: { title: "Plan the launch party", stillOn: MARKETING_BOARD },
      to: { kind: "team", name: "Product" },
      setback: "noAccess",
      notedAt: START + MINUTE,
    },
  ]);
});

test("a move already on its way when notes began leaves one note when it's given up", async () => {
  const id = movingBeforeNotes();
  kit.fail(PRODUCT, "receiveMove", "silent");
  kit.fail(PRODUCT, "dropMoveIn", "silent");
  await laterAlarm(MARKETING, 60 * MINUTE);
  await laterAlarm();
  expect(await notesFor()).toMatchObject([
    { task: { title: "Plan the launch party" }, setback: "noAnswer" },
  ]);
  expect(await (await kit.as(ALICE)).findTask(id)).toMatchObject({
    moving: null,
  });
});

test("a note D1 couldn't be told about still arrives after a save that failed outright", async () => {
  kit.d1Failures.moveNotices = true;
  const postpone = spyOn(
    TaskStore.prototype,
    "postponeNoticeIndexWrites",
  ).mockImplementationOnce(() => {
    throw new Error("The object's storage is unavailable");
  });
  await refusedLater().catch(() => {});
  postpone.mockRestore();

  kit.d1Failures.moveNotices = false;
  await laterAlarm();
  expect(await notesFor()).toMatchObject([{ setback: "noAccess" }]);
});
