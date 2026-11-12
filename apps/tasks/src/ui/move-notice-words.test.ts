import type { BoardId } from "@cloudysuite/access";
import { expect, test } from "bun:test";
import type { MoveNotice, MoveSetback } from "../types";
import { noticeWords } from "./move-notice-words";

const MARKETING = "1b3f4e30-ac2d-4f90-9e77-2c3d4e5f6071" as BoardId;
const MARKETING_BOARD = {
  id: MARKETING,
  kind: "team",
  name: "Marketing",
  colour: 2,
} as const;

function sentence(
  setback: MoveSetback,
  options: { private?: boolean; hidden?: boolean } = {},
) {
  const notice: MoveNotice = {
    moveId: "move-1",
    boardId: MARKETING,
    to: options.private
      ? { kind: "personal", name: "Alice Stone" }
      : { kind: "team", name: "Product" },
    setback,
    notedAt: 0,
    task: options.hidden
      ? null
      : { title: "Plan the launch party", stillOn: MARKETING_BOARD },
  };
  const { lead, rest, next } = noticeWords(notice);
  return `${lead}${rest} ${next}`;
}

test("a note says what didn't move, why, where it is, and what to do next", () => {
  expect(sentence("noAccess")).toBe(
    `"Plan the launch party" didn't move to Product, because you no longer have Can edit there. It's still on Marketing. Ask one of Product's managers for Can edit, then move it again.`,
  );
  expect(sentence("noAccess", { private: true })).toBe(
    `"Plan the launch party" didn't move to your private tasks, because you can no longer add tasks there. It's still on Marketing. You can move it to another board instead.`,
  );
  expect(sentence("busy")).toBe(
    `"Plan the launch party" didn't move to Product, because Product couldn't take it just then. It's still on Marketing. Move it again in a minute.`,
  );
  expect(sentence("noAnswer")).toBe(
    `"Plan the launch party" didn't move to Product, because we couldn't get it there for an hour, so we stopped trying. It's still on Marketing. Move it again to try once more.`,
  );
});

test("once the person can't open its board, a note leaves out only the task's name", () => {
  expect(sentence("noAccess", { hidden: true })).toBe(
    "A task you moved didn't move to Product, because you no longer have Can edit there. It's still on a board you can no longer open. If it still needs to move, ask someone on that board to move it.",
  );
  expect(sentence("noAccess", { private: true, hidden: true })).toBe(
    "A task you moved didn't move to your private tasks, because you can no longer add tasks there. It's still on a board you can no longer open. If it still needs to move, ask someone on that board to move it.",
  );
  expect(sentence("dropped", { hidden: true })).toBe(
    "A task you moved didn't move to Product, because Product couldn't take it just then. It's still on a board you can no longer open. If it still needs to move, ask someone on that board to move it.",
  );
  expect(sentence("noAnswer", { hidden: true })).toBe(
    "A task you moved didn't move to Product, because we couldn't get it there for an hour, so we stopped trying. It's still on a board you can no longer open. If it still needs to move, ask someone on that board to move it.",
  );
});
