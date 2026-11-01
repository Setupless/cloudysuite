import { expect, test } from "bun:test";
import { createTestDatabase } from "../../../src/db/test-database";
import {
  askYesNo,
  checkJevKey,
  JEV_API,
  jevApiBase,
  jevKeyIsSet,
  parseAnswers,
  readJevKey,
  writeJevKey,
} from "./index";

test.each([
  [undefined, JEV_API],
  ["", JEV_API],
  ["not a url", JEV_API],
  ["https://attacker.example", JEV_API],
  ["http://localhost.attacker.example:9", JEV_API],
  ["http://localhost:9911/", "http://localhost:9911"],
  ["http://127.0.0.1:9911", "http://127.0.0.1:9911"],
])("the override %s reaches %s", (override, base) => {
  expect(jevApiBase(override)).toBe(base);
});

const good = {
  model: "jev-1.14.0",
  answers: { spam: { type: "noul", noul: 0.5 } },
  usage: { input_tokens: 10, output_tokens: 0 },
};

test("a documented answer parses to its numbers alone", () => {
  expect(parseAnswers(good, ["spam"])).toEqual({
    yes: { spam: 0.5 },
    inputTokens: 10,
  });
});

test.each([
  ["no model", { ...good, model: undefined }],
  ["no usage", { ...good, usage: undefined }],
  ["negative tokens", { ...good, usage: { input_tokens: -1 } }],
  ["fractional tokens", { ...good, usage: { input_tokens: 1.5 } }],
  ["a missing answer", { ...good, answers: {} }],
  ["an unasked answer", { ...good, answers: { other: good.answers.spam } }],
  [
    "an extra answer",
    { ...good, answers: { ...good.answers, more: good.answers.spam } },
  ],
  ["a string", { ...good, answers: { spam: { type: "noul", noul: "1" } } }],
  ["above 1", { ...good, answers: { spam: { type: "noul", noul: 1.01 } } }],
  ["below 0", { ...good, answers: { spam: { type: "noul", noul: -0.01 } } }],
  ["null", { ...good, answers: { spam: { type: "noul", noul: null } } }],
  ["another type", { ...good, answers: { spam: { type: "score", score: 1 } } }],
  ["an array", []],
  ["nothing", null],
])("%s is not an answer", (_, raw) => {
  expect(parseAnswers(raw, ["spam"])).toBeNull();
});

test("an asked question named like an object property isn't answered by it", () => {
  expect(parseAnswers({ ...good, answers: {} }, ["constructor"])).toBeNull();
});

const connection = (respond: () => Response | Promise<Response>) => ({
  base: JEV_API,
  key: "k",
  fetch: async () => respond(),
});

test("the key check gives a plain result without spending tokens", async () => {
  const seen: string[] = [];
  const check = await checkJevKey({
    base: JEV_API,
    key: "k",
    fetch: async (url, init) => {
      seen.push(`${init.method ?? "GET"} ${url}`);
      return Response.json({ models: [] });
    },
  });
  expect(check).toBe("accepted");
  expect(seen).toEqual([`GET ${JEV_API}/v1/models`]);
  expect(
    await checkJevKey(connection(() => new Response("{}", { status: 401 }))),
  ).toBe("rejected");
  expect(
    await checkJevKey(connection(() => new Response("{}", { status: 529 }))),
  ).toBe("unknown");
  expect(
    await checkJevKey(
      connection(() => {
        throw new TypeError("no route");
      }),
    ),
  ).toBe("unknown");
});

test("a key can be added, replaced, and removed", async () => {
  const { d1 } = createTestDatabase();
  expect(await jevKeyIsSet(d1)).toBe(false);
  await writeJevKey(d1, "first");
  expect(await jevKeyIsSet(d1)).toBe(true);
  await writeJevKey(d1, "second");
  expect(await readJevKey(d1)).toBe("second");
  await writeJevKey(d1, null);
  expect(await jevKeyIsSet(d1)).toBe(false);
  expect(await readJevKey(d1)).toBeNull();
});

test("a redirect is a failed check, and its target is never asked", async () => {
  const asked: string[] = [];
  const answer = {
    model: "jev-1.14.0",
    answers: { spam: { type: "noul", noul: 1 } },
    usage: { input_tokens: 1, output_tokens: 0 },
  };
  const follows = (url: string, init: RequestInit): Response => {
    asked.push(url);
    if (url.startsWith("http://second.test")) return Response.json(answer);
    return init.redirect === "manual"
      ? new Response(null, {
          status: 302,
          headers: { Location: "http://second.test/v1/systemone" },
        })
      : Response.json(answer);
  };
  const result = await askYesNo(
    { base: JEV_API, key: "k", fetch: async (url, init) => follows(url, init) },
    {},
    { spam: { instructions: "Is it spam?" } },
  );
  expect(result.ok).toBe(false);
  expect(asked).toEqual([`${JEV_API}/v1/systemone`]);
});
