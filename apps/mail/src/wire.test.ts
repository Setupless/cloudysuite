import { expect, test } from "bun:test";
import {
  parseFlagsInput,
  parseListInput,
  parseMailboxInput,
  parseMoveInput,
  parseSelectionInput,
} from "./wire";

const mailboxId = "6f1d2c1e-8a0b-4d7e-9c55-0a1b2c3d4e5f";

const refusal = async (run: () => unknown) => {
  try {
    run();
  } catch (thrown) {
    return (thrown as Response).status;
  }
  return "accepted";
};

test("a mailbox id must be a real id, not a name or a trick", async () => {
  expect(parseMailboxInput({ mailboxId }).mailboxId as string).toBe(mailboxId);
  for (const bad of [
    undefined,
    null,
    "",
    "alex@example.org",
    `${mailboxId}/../other`,
    mailboxId.toUpperCase(),
    42,
    { toString: () => mailboxId },
  ]) {
    expect(await refusal(() => parseMailboxInput({ mailboxId: bad }))).toBe(
      400,
    );
  }
  expect(await refusal(() => parseMailboxInput(null))).toBe(400);
});

test("a list request accepts a folder or a label and bounded paging only", async () => {
  expect(
    parseListInput({ mailboxId, view: { folder: "inbox" }, cursor: "1_2" })
      .view,
  ).toEqual({ folder: "inbox" });
  expect(parseListInput({ mailboxId, view: { labelId: 3 } }).view).toEqual({
    labelId: 3 as never,
  });
  for (const bad of [
    { view: { folder: "nowhere" } },
    { view: { labelId: -1 } },
    { view: { labelId: "1 OR 1=1" } },
    { view: { folder: "inbox" }, cursor: "x".repeat(65) },
    { view: { folder: "inbox" }, cursor: 5 },
    { view: { folder: "inbox" }, limit: 101 },
    { view: { folder: "inbox" }, limit: 0 },
  ]) {
    expect(await refusal(() => parseListInput({ mailboxId, ...bad }))).toBe(
      400,
    );
  }
});

test("a selection must be small, non-empty, and only positive whole numbers", async () => {
  expect(
    parseSelectionInput({
      mailboxId,
      selection: { threadIds: [1, 2], inFolder: "trash" },
    }).selection,
  ).toEqual({ threadIds: [1, 2] as never, inFolder: "trash" });
  for (const selection of [
    {},
    { threadIds: [] },
    { messageIds: [] },
    { threadIds: [0] },
    { threadIds: [1.5] },
    { messageIds: ["1"] },
    { threadIds: Array.from({ length: 101 }, (_, index) => index + 1) },
    { threadIds: [1], inFolder: "nowhere" },
  ]) {
    expect(
      await refusal(() => parseSelectionInput({ mailboxId, selection })),
    ).toBe(400);
  }
});

test("flag and move requests say what to change", async () => {
  const selection = { threadIds: [1] };
  expect(
    parseFlagsInput({ mailboxId, selection, flags: { read: true } }).flags,
  ).toEqual({ read: true, starred: undefined });
  for (const flags of [{}, { read: "yes" }, null]) {
    expect(
      await refusal(() => parseFlagsInput({ mailboxId, selection, flags })),
    ).toBe(400);
  }
  expect(
    await refusal(() =>
      parseMoveInput({ mailboxId, selection, folder: "nowhere" }),
    ),
  ).toBe(400);
});
