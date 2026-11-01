import { expect, test } from "bun:test";
import { parseSearch, toMatchExpression } from "./query";

const queryOf = (text: string, offset = 0) => {
  const parsed = parseSearch(text, offset);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.query;
};
const problemOf = (text: string) => {
  const parsed = parseSearch(text, 0);
  if (parsed.ok) throw new Error(`"${text}" should not parse`);
  return parsed.problem;
};

test("each operator narrows the search", () => {
  const query = queryOf(
    'from:priya to:sam subject:"q3 numbers" has:attachment is:unread is:starred in:archive label:"To do" before:2026-04-01 after:2026/03/01 budget "exact words"',
  );
  expect(query.terms).toEqual([
    { column: "sender", phrase: "priya" },
    { column: "recipients", phrase: "sam" },
    { column: "subject", phrase: "q3 numbers" },
    { column: null, phrase: "budget" },
    { column: null, phrase: "exact words" },
  ]);
  expect(query).toMatchObject({
    hasAttachment: true,
    unread: true,
    starred: true,
    folder: "archive",
    labels: ["To do"],
    receivedBefore: Date.UTC(2026, 3, 1),
    receivedAfter: Date.UTC(2026, 2, 1),
  });
});

test("operators ignore case", () => {
  expect(queryOf("FROM:Priya IN:Trash").folder).toBe("trash");
});

test("a date means the reader's own day", () => {
  // Sydney in summer is 11 hours ahead of UTC, and its offset is negative.
  expect(queryOf("before:2026-01-10", -660).receivedBefore).toBe(
    Date.UTC(2026, 0, 9, 13),
  );
});

test("a year before 100 stays in that year", () => {
  const early = new Date(0);
  early.setUTCFullYear(99, 0, 1);
  expect(queryOf("before:0099-01-01").receivedBefore).toBe(early.getTime());
  expect(queryOf("after:0099-01-01").receivedAfter).not.toBe(
    Date.UTC(1999, 0, 1),
  );
});

test("no hostile text can reach the index as syntax", () => {
  for (const text of [
    'foo"bar',
    'a" OR "b',
    "NEAR(a b)",
    "OR OR",
    "col:x",
    "subject:x)",
    "a*",
    "^a",
    "(a",
    "a AND",
    "NOT a",
    'from:"a" b" c',
    "a\u0000b",
    "sender:a",
  ]) {
    const expression = toMatchExpression(queryOf(text).terms)!;
    const inner = expression.replace(/(sender|subject|recipients) : /g, "");
    expect(inner).toMatch(/^"[\p{L}\p{N} ]+"( AND "[\p{L}\p{N} ]+")*$/u);
  }
});

test("an unknown operator is plain words", () => {
  expect(queryOf("col:x").terms).toEqual([{ column: null, phrase: "col x" }]);
  expect(queryOf("https://example.org").terms).toEqual([
    { column: null, phrase: "https example org" },
  ]);
});

test("a known operator with no value is plain words", () => {
  expect(queryOf("from:").terms).toEqual([{ column: null, phrase: "from" }]);
});

test("an unclosed quote takes the rest of the line", () => {
  expect(queryOf('"two words').terms).toEqual([
    { column: null, phrase: "two words" },
  ]);
});

test("searches that can't run explain themselves in plain words", () => {
  for (const text of ['"', "*", ")", "(((", "   ", ""]) {
    expect(problemOf(text)).toContain("Add a word");
  }
  expect(problemOf("in:nowhere")).toContain('no folder called "nowhere"');
  expect(problemOf("is:happy")).toContain("is:unread");
  expect(problemOf("has:pdf")).toContain("has:attachment");
  expect(problemOf("before:soon")).toContain("2026-03-31");
  expect(problemOf("after:2026-02-31")).toContain("2026-02-31");
  expect(problemOf("x".repeat(501))).toContain("too long");
  expect(problemOf(Array(33).fill("word").join(" "))).toContain("too many");
});
