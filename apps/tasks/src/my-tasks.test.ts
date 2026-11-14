import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { BoardClient } from "./client";
import {
  ALICE,
  BOB,
  CAROL,
  create,
  createBoardTest,
  newTaskId,
} from "./test-support";
import type { Person } from "./types";

let kit: ReturnType<typeof createBoardTest>;
const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-12T09:00:00Z");
const TODAY = START - 2 * 60 * 60 * 1000;

beforeEach(() => {
  kit = createBoardTest();
});

afterEach(() => {
  setSystemTime();
});

// Adds one task of each kind My tasks must tell apart, done a day ago or now.
async function addEach(board: BoardClient, assignee: Person | null) {
  const add = async (title: string, at: number, done: boolean) => {
    setSystemTime(at);
    const id = newTaskId();
    await board.change(create(id, { title, assignee }));
    if (done) await board.change({ kind: "setStatus", id, status: "done" });
    return id;
  };
  await add("Done yesterday", START - DAY, true);
  await add("Open", START, false);
  await add("Done today", START, true);
  for (const done of [false, true]) {
    const id = await add("Deleted", START, done);
    await board.change({ kind: "delete", id });
  }
}

const titles = async (board: BoardClient) =>
  (await board.listMyTasks(TODAY)).map((task) => task.title);

test("on a team board, My tasks lists only what's assigned to me and open or done today", async () => {
  kit.join(BOB, "editor");
  const alice = await kit.as(ALICE);
  await addEach(alice, BOB);
  await addEach(alice, CAROL);
  await addEach(alice, null);

  expect(await titles(await kit.as(BOB))).toEqual(["Open", "Done today"]);
  expect(await titles(alice)).toEqual([]);
});

test("on my own board, My tasks lists everything open or done today", async () => {
  const own = await kit.as(ALICE, await kit.personalBoardOf(ALICE));
  await addEach(own, null);

  expect(await titles(own)).toEqual(["Open", "Done today"]);
});
