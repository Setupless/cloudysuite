import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import packageJson from "../package.json";

const ROOT = join(import.meta.dir, "../../..");

function productionFiles(): string[] {
  return ["src", "apps", "packages"].flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .filter(
        (file) =>
          /\.(ts|tsx)$/.test(file) &&
          !file.includes("node_modules") &&
          !/(\.test\.|test-support)/.test(file),
      )
      .map((file) => join(ROOT, dir, file)),
  );
}

const usersOf = (pattern: RegExp) =>
  productionFiles()
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file))
    .sort();

test("only stub.ts touches the calendar binding", () => {
  expect(usersOf(/\benv\.CALENDAR\b/)).toEqual(["apps/calendar/src/stub.ts"]);
});

test("only the access-checked client imports the stub", () => {
  expect(
    usersOf(/from "[^"]*\/stub"/).filter((file) =>
      file.startsWith("apps/calendar/"),
    ),
  ).toEqual(["apps/calendar/src/client.ts"]);
});

test("only the access check's own module opens a calendar for a person", () => {
  expect(usersOf(/\bopenCalendar\(/)).toEqual(["apps/calendar/src/client.ts"]);
  expect(usersOf(/\bopenCalendarAsPerson\(/)).toEqual([
    "apps/calendar/src/access.ts",
    "apps/calendar/src/client.ts",
  ]);
  expect(usersOf(/\bcheckCalendarAccess\(/)).toEqual([
    "apps/calendar/src/client.ts",
    "packages/access/src/index.ts",
  ]);
});

test("every Calendar method that touches events is told who is asking", () => {
  const source = readFileSync(join(import.meta.dir, "calendar.ts"), "utf8");
  const methods = [
    ...source.matchAll(
      /^ {2}(?:async )?([a-zA-Z][a-zA-Z0-9]*)\(([\s\S]*?)\)(?:: [^{]+)? \{$/gm,
    ),
  ].filter(([, name]) => name !== "constructor");
  expect(methods.length).toBeGreaterThan(3);
  for (const [, name, parameters] of methods) {
    expect([name, /\b_?actor: Actor\b/.test(parameters as string)]).toEqual([
      name,
      true,
    ]);
  }
});

test("only the Calendar object makes an event store", () => {
  expect(usersOf(/\bnew EventStore\b/)).toEqual([
    "apps/calendar/src/calendar.ts",
  ]);
});

test("Calendar's code reaches the sign-in rule only through the Calendar-on check", () => {
  expect(
    usersOf(/\brequire(Ready|SignedIn|Admin)User\(/).filter((file) =>
      file.startsWith("apps/calendar/"),
    ),
  ).toEqual(["apps/calendar/src/access.ts"]);
});

test("the package does not export the stub or the store", () => {
  expect(Object.keys(packageJson.exports).sort()).toEqual([
    ".",
    "./calendar",
    "./routes",
  ]);
});
