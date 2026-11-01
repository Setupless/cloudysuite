import { expect, test } from "bun:test";
import {
  MOVES_BY_FOLDER,
  movesFor,
  parseThreadParam,
  parseViewParam,
  viewParam,
} from "./model";
import { FOLDERS, type ThreadView } from "./types";

test("every folder and label has an address that reads back the same", () => {
  const views: ThreadView[] = [
    ...FOLDERS.map((folder) => ({ folder })),
    { labelId: 12 as never },
  ];
  for (const view of views) {
    expect(parseViewParam(viewParam(view))).toEqual(view);
  }
});

test("an address that is not a folder or a label is refused", () => {
  for (const raw of [
    "",
    "starred",
    "constructor",
    "__proto__",
    "label-",
    "label-0",
    "label-x",
    "label--1",
  ]) {
    expect(parseViewParam(raw)).toBeNull();
  }
  for (const raw of ["", "0", "-1", "1.5", "1e3", "abc"]) {
    expect(parseThreadParam(raw)).toBeNull();
  }
});

test("mail can be deleted forever only from Trash and Spam", () => {
  const withDelete = FOLDERS.filter((folder) =>
    MOVES_BY_FOLDER[folder].includes("deleteForever"),
  );
  expect(withDelete.sort()).toEqual(["spam", "trash"]);
});

test("every folder offers a way out, and a label view moves nothing yet", () => {
  for (const folder of FOLDERS) {
    expect(MOVES_BY_FOLDER[folder].length).toBeGreaterThan(0);
  }
  expect(movesFor({ labelId: 1 as never })).toEqual([]);
});
