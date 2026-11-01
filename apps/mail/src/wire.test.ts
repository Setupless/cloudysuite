import { expect, test } from "bun:test";
import { parseNewRuleInput, parseReorderInput } from "./rules/wire";
import { MAX_SEARCH_LENGTH, parseSearch } from "./search/query";
import {
  parseFlagsInput,
  parseListInput,
  parseMailboxInput,
  parseMoveInput,
  parseNewLabelInput,
  parseSearchInput,
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

test("search text past the limit is cut, and still reads as too long", () => {
  const { text } = parseSearchInput({
    mailboxId,
    text: "x".repeat(102_400),
    offsetMinutes: 0,
  });
  expect(text).toHaveLength(MAX_SEARCH_LENGTH + 1);
  expect(parseSearch(text, 0)).toMatchObject({ ok: false });
});

test("a search needs text and a real time zone offset", () => {
  const refused = (input: object) =>
    expect(() => parseSearchInput({ mailboxId, ...input })).toThrow();
  refused({ text: 42, offsetMinutes: 0 });
  refused({ text: "a", offsetMinutes: 100_000 });
  refused({ text: "a", offsetMinutes: "0" });
  refused({ text: "a", offsetMinutes: 0, cursor: "x".repeat(65) });
});

test("a label name is checked here, and a bad colour is refused", async () => {
  const input = { mailboxId, name: "  Work  ", colour: "accent" };
  expect(parseNewLabelInput(input).name).toBe("Work");
  expect(() =>
    parseNewLabelInput({ ...input, colour: "not-a-role" }),
  ).toThrow();
  expect(() => parseNewLabelInput({ ...input, colour: "red-500" })).toThrow();
  try {
    parseNewLabelInput({ ...input, name: "x".repeat(65) });
    throw new Error("should refuse");
  } catch (thrown) {
    const response = thrown as Response;
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain(
      "name of up to",
    );
  }
});

test("a move can name one folder or several, and only real ones", () => {
  const base = { mailboxId, folder: "trash" };
  const selection = (inFolder: unknown) => ({
    ...base,
    selection: { threadIds: [1], inFolder },
  });
  expect(parseMoveInput(selection(["inbox", "sent"])).selection).toMatchObject({
    inFolder: ["inbox", "sent"],
  });
  expect(parseMoveInput(selection("inbox")).selection).toMatchObject({
    inFolder: "inbox",
  });
  expect(() => parseMoveInput(selection([]))).toThrow();
  expect(() => parseMoveInput(selection(["nowhere"]))).toThrow();
  expect(() => parseMoveInput(selection(Array(7).fill("inbox")))).toThrow();
});

test("a bad rule is refused with what to fix", async () => {
  try {
    parseNewRuleInput({
      mailboxId,
      rule: {
        name: "",
        enabled: true,
        match: "all",
        conditions: [],
        actions: {},
      },
    });
    throw new Error("should refuse");
  } catch (thrown) {
    const response = thrown as Response;
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toBe(
      "Give the rule a name.",
    );
  }
});

test("a reorder can't be larger than the rule limit", () => {
  expect(() =>
    parseReorderInput({ mailboxId, ruleIds: Array(101).fill(1) }),
  ).toThrow();
  expect(parseReorderInput({ mailboxId, ruleIds: [2, 1] }).ruleIds).toEqual([
    2, 1,
  ] as never);
});
