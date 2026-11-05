import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import packageJson from "../package.json";

const ROOT = join(import.meta.dir, "../../..");

// A glob doesn't follow links, so it never walks into a package through node_modules,
// where Mail and Calendar, which use each other, would loop.
function productionFiles(): string[] {
  return ["src", "apps", "packages"].flatMap((dir) =>
    [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(ROOT, dir) })]
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

// Another Calendar object calls these to hand over an invitation copy or an answer. They
// take no person, so no person may reach them.
const OBJECT_TO_OBJECT = ["receiveInvitation", "receiveAnswer"];

test("every Calendar method that touches events is told who is asking", () => {
  const source = readFileSync(join(import.meta.dir, "calendar.ts"), "utf8");
  const methods = [
    ...source.matchAll(
      /^ {2}(?:override )?(?:async )?([a-zA-Z][a-zA-Z0-9]*)\(([\s\S]*?)\)(?:: [^{]+)? \{$/gm,
    ),
  ].filter(([, name]) => name !== "constructor");
  expect(methods.length).toBeGreaterThan(3);
  for (const [, name, parameters] of methods) {
    if (name === "alarm" || OBJECT_TO_OBJECT.includes(name as string)) continue;
    expect([name, /\b_?actor: Actor\b/.test(parameters as string)]).toEqual([
      name,
      true,
    ]);
  }
});

test("only a Calendar object hands an invitation or an answer to another calendar", () => {
  expect(usersOf(/\binvitationReceiver\(/)).toEqual([
    "apps/calendar/src/calendar.ts",
    "apps/calendar/src/client.ts",
  ]);
  // Only stub.ts reaches the binding, so another app's code can't reach these at all.
  const inCalendar = (file: string) =>
    file.startsWith("apps/calendar/") || file.startsWith("src/");
  for (const method of OBJECT_TO_OBJECT) {
    const callers = usersOf(new RegExp(`\\b${method}\\b`)).filter(inCalendar);
    expect([method, callers]).toEqual([
      method,
      [
        "apps/calendar/src/calendar.ts",
        "apps/calendar/src/client.ts",
        "apps/calendar/src/store.ts",
      ],
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
