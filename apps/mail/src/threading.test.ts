import { expect, test } from "bun:test";
import {
  normalizeSubject,
  parseMessageIds,
  parseReferences,
  sameConversation,
} from "./threading";

test.each([
  ["Hello", "hello", false],
  ["Re: Hello", "hello", true],
  ["RE:  re: Hello  world", "hello world", true],
  ["Fwd: Hello", "hello", false],
  ["Fw: Re: Hello", "hello", true],
  ["AW: Hello", "hello", true],
  ["Re[2]: Hello", "hello", true],
  ["[team] Re: Hello", "hello", true],
  ["[team] Hello", "hello", false],
  ["Regarding: Hello", "regarding: hello", false],
  ["", "", false],
  ["Re:", "", true],
])("normalizeSubject(%j)", (subject, normalized, isReply) => {
  expect(normalizeSubject(subject)).toEqual({ normalized, isReply });
});

test("a long run of reply prefixes is handled quickly", () => {
  const started = performance.now();
  expect(normalizeSubject("re:".repeat(100_000) + "x").isReply).toBe(true);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("message ids come out of brackets, and oversized ones are dropped", () => {
  expect(parseMessageIds("<a@x> <b@y>\r\n <c@z>")).toEqual([
    "a@x",
    "b@y",
    "c@z",
  ]);
  expect(parseMessageIds("no-brackets@x")).toEqual(["no-brackets@x"]);
  expect(parseMessageIds(`<${"a".repeat(2000)}@x>`)).toEqual([]);
  expect(parseMessageIds(null)).toEqual([]);
});

test("In-Reply-To counts as the direct parent", () => {
  expect(parseReferences("<a@x> <b@x>", "<c@x>")).toEqual([
    "a@x",
    "b@x",
    "c@x",
  ]);
  expect(parseReferences("<a@x> <b@x>", "<a@x>")).toEqual(["b@x", "a@x"]);
  expect(parseReferences(null, null)).toEqual([]);
});

test("a very long References header keeps the root and the latest ids", () => {
  const ids = Array.from({ length: 5000 }, (_, index) => `<${index}@x>`);
  const kept = parseReferences(ids.join(" "), null);
  expect(kept).toHaveLength(50);
  expect(kept[0]).toBe("0@x");
  expect(kept.at(-1)).toBe("4999@x");
});

test("a conversation needs both senders in each other's message", () => {
  const alice = { from: "a@x", participants: ["a@x", "b@x"] };
  const bob = { from: "b@x", participants: ["b@x", "a@x"] };
  const carol = { from: "c@x", participants: ["c@x", "a@x"] };
  expect(sameConversation(alice, bob)).toBe(true);
  expect(sameConversation(bob, alice)).toBe(true);
  expect(sameConversation(alice, carol)).toBe(false);
  expect(sameConversation(carol, alice)).toBe(false);
  expect(sameConversation({ from: null, participants: [] }, alice)).toBe(false);
});
