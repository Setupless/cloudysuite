import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import packageJson from "../package.json";

const ROOT = join(import.meta.dir, "../../..");

// A glob doesn't follow links, so it never walks into a package through node_modules.
function productionFiles(): string[] {
  return ["src", "apps", "packages"].flatMap((dir) =>
    [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(ROOT, dir) })]
      .filter(
        (file) =>
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

test("only stub.ts touches the board binding", () => {
  expect(usersOf(/\benv\.BOARD\b/)).toEqual(["apps/tasks/src/stub.ts"]);
});

test("only the access-checked client imports the stub", () => {
  expect(
    usersOf(/from "[^"]*\/stub"/).filter((file) =>
      file.startsWith("apps/tasks/"),
    ),
  ).toEqual(["apps/tasks/src/client.ts"]);
  expect(usersOf(/\bcheckBoardAccess\(/)).toEqual([
    "apps/tasks/src/client.ts",
    "packages/access/src/index.ts",
  ]);
});

test("every Board method is told who is asking", () => {
  const source = readFileSync(join(import.meta.dir, "board.ts"), "utf8");
  const methods = [
    ...source.matchAll(
      /^ {2}(?:override )?(?:async )?([a-zA-Z][a-zA-Z0-9]*)\(([\s\S]*?)\)(?:: [^{]+)? \{$/gm,
    ),
  ].filter(([, name]) => name !== "constructor" && name !== "alarm");
  expect(methods.length).toBeGreaterThan(2);
  for (const [name, parameters] of methods.map(([, n, p]) => [n, p])) {
    expect([name, /\b_?actor: Actor\b/.test(parameters as string)]).toEqual([
      name,
      true,
    ]);
  }
});

test("only the Board object makes a task store", () => {
  expect(usersOf(/\bnew TaskStore\b/)).toEqual(["apps/tasks/src/board.ts"]);
});

test("the package does not export the stub or the store", () => {
  expect(Object.keys(packageJson.exports).sort()).toEqual([
    ".",
    "./board",
    "./routes",
  ]);
});
