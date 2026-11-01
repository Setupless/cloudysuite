import { expect, test } from "bun:test";
import { createUpdateChecker, isNewer } from "./updates";

test.each([
  ["1.0.0", "0.9.9", true],
  ["v0.2.0", "0.1.9", true],
  ["0.1.10", "0.1.9", true],
  ["0.1.9", "0.1.9", false],
  ["0.1.0", "0.2.0", false],
  ["nightly", "0.1.0", false],
  ["1.0.0-rc.1", "0.1.0", false],
])("is %s newer than %s", (candidate, running, expected) => {
  expect(isNewer(candidate, running)).toBe(expected);
});

const release =
  (tag: unknown, url: unknown = `https://github.com/x/releases/tag/${tag}`) =>
  async () =>
    Response.json({ tag_name: tag, html_url: url });

test("a newer release produces a notice with its link", async () => {
  const check = createUpdateChecker("0.1.0", release("v0.2.0"));
  expect(await check()).toEqual({
    kind: "available",
    latest: "0.2.0",
    releaseUrl: "https://github.com/x/releases/tag/v0.2.0",
  });
});

test("the running version is silent", async () => {
  expect(await createUpdateChecker("0.2.0", release("v0.2.0"))()).toEqual({
    kind: "none",
  });
});

test.each([
  ["no release yet", async () => new Response("{}", { status: 404 })],
  ["a server error", async () => new Response("", { status: 500 })],
  [
    "no network",
    async () => {
      throw new Error("offline");
    },
  ],
  ["unreadable JSON", async () => new Response("not json")],
  ["an unexpected shape", async () => Response.json({ tag_name: 7 })],
  ["a link off GitHub", release("v9.0.0", "https://evil.example/")],
] as const)("%s is silent", async (_, fetcher) => {
  expect(await createUpdateChecker("0.1.0", fetcher)()).toEqual({
    kind: "none",
  });
});

test("the answer is cached for a while, then checked again", async () => {
  let calls = 0;
  let now = 0;
  const check = createUpdateChecker(
    "0.1.0",
    async () => {
      calls++;
      return new Response("", { status: 500 });
    },
    () => now,
  );
  await check();
  await check();
  expect(calls).toBe(1);
  now = 61 * 60 * 1000;
  await check();
  expect(calls).toBe(2);
});
