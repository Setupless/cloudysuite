import { expect, test } from "bun:test";
import {
  listingSearchParams,
  MOVES_BY_FOLDER,
  movesFor,
  parseListing,
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

test("every folder offers a way out", () => {
  for (const folder of FOLDERS) {
    expect(MOVES_BY_FOLDER[folder].length).toBeGreaterThan(0);
  }
});

test("a folder's moves come from the folder, whatever the messages say", () => {
  expect(movesFor({ folder: "inbox" }, ["archive"])).toEqual(
    MOVES_BY_FOLDER.inbox,
  );
});

test("a label or search offers the moves that fit where the mail is", () => {
  const label = { labelId: 1 as never };
  expect(movesFor(label, ["inbox", "sent"])).toEqual([
    "archive",
    "spam",
    "trash",
  ]);
  expect(movesFor(label, ["archive"])).toEqual(["toInbox", "spam", "trash"]);
  expect(movesFor(label, ["inbox", "archive"])).toEqual([
    "archive",
    "toInbox",
    "spam",
    "trash",
  ]);
  expect(movesFor({ search: "x" }, ["trash"])).toEqual([
    "restore",
    "deleteForever",
  ]);
});

test("a search keeps its text in the URL and only a search does", () => {
  expect(parseListing("search", "from:a")).toEqual({ search: "from:a" });
  expect(viewParam({ search: "from:a" })).toBe("search");
  expect(listingSearchParams({ search: "from:a" })).toEqual({ q: "from:a" });
  expect(parseListing("inbox", "ignored")).toEqual({ folder: "inbox" });
  expect(listingSearchParams({ folder: "inbox" })).toEqual({});
});
