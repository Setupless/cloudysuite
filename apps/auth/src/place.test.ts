import { describe, expect, test } from "bun:test";
import { parsePath, parsePlace } from "./place";

// A GET server function with no ?payload= reaches its validator as undefined.
async function refusal(run: () => unknown): Promise<number | string> {
  try {
    run();
  } catch (thrown) {
    return thrown instanceof Response ? thrown.status : String(thrown);
  }
  return "accepted";
}

describe("page checks without a payload", () => {
  test.each([
    undefined,
    null,
    "text",
    {},
    { app: "auth" },
    { app: "auth", path: 4 },
  ])("refuses %p as the app and path", async (input) => {
    expect(await refusal(() => parsePlace(input as never))).toBe(400);
  });

  test.each([undefined, null, "text", {}, { path: 4 }])(
    "refuses %p as the path",
    async (input) => {
      expect(await refusal(() => parsePath(input as never))).toBe(400);
    },
  );

  test("accepts a real place", () => {
    expect(parsePlace({ app: "mail", path: "/inbox?x=1" })).toEqual({
      app: "mail",
      path: "/inbox?x=1",
    });
    expect(parsePath({ path: "/people" })).toEqual({ path: "/people" });
  });
});
