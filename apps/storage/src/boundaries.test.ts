import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import packageJson from "../package.json";

const ROOT = join(import.meta.dir, "../../..");

// A glob doesn't follow links, so it never walks into a package through node_modules,
// where two packages that use each other would loop.
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

test("only stub.ts touches the drive binding", () => {
  expect(usersOf(/\benv\.DRIVE\b/)).toEqual(["apps/storage/src/stub.ts"]);
});

test("only the access-checked client imports the stub", () => {
  expect(
    usersOf(/from "[^"]*\/stub"/).filter((f) => f.includes("storage")),
  ).toEqual(["apps/storage/src/client.ts"]);
});

test("only the access check's own module opens a drive for a person", () => {
  expect(usersOf(/\bopenDrive\(/)).toEqual(["apps/storage/src/client.ts"]);
  expect(usersOf(/\bopenDriveAsPerson\(/)).toEqual([
    "apps/storage/src/access.ts",
    "apps/storage/src/client.ts",
  ]);
  expect(usersOf(/\bcheckDriveAccess\(/)).toEqual([
    "apps/storage/src/client.ts",
    "packages/access/src/index.ts",
  ]);
});

// The object decides what a person reaches in the call that does the work, so it can't
// be asked about an item without being told who's asking. These few take no person.
const NO_PERSON_NEEDED = new Set([
  // Finish a move both drives already approved.
  "receiveMove",
  "confirmMoveIn",
  "abandonMoveIn",
  // The Worker asks these only after its own check, and they give nothing away: the first
  // only after mayAddTo, the second only about this person's own uploads.
  "folderExists",
  "findUpload",
  // Only after the Worker has checked for a manager on D1.
  "close",
  "reopen",
]);

test("every Drive method that touches items is told who is asking", () => {
  const source = readFileSync(join(import.meta.dir, "drive.ts"), "utf8");
  const methods = [
    ...source.matchAll(
      /^ {2}(?:async )?([a-zA-Z][a-zA-Z0-9]*)\(([\s\S]*?)\)(?:: [^{]+)? \{$/gm,
    ),
  ].filter(([, name]) => name !== "constructor");
  expect(methods.length).toBeGreaterThan(20);
  for (const [, name, parameters] of methods) {
    if (name === "alarm" || NO_PERSON_NEEDED.has(name as string)) continue;
    expect([name, /\bactor: Actor\b/.test(parameters as string)]).toEqual([
      name,
      true,
    ]);
  }
});

test("no server function asks the object for an item without a client", () => {
  expect(usersOf(/\bnew DriveStore\b/)).toEqual(["apps/storage/src/drive.ts"]);
});

test("Storage's code reaches the sign-in rule only through the Storage-on check", () => {
  expect(
    usersOf(/\brequireReadyUser\(/).filter((f) => f.startsWith("apps/storage")),
  ).toEqual(["apps/storage/src/access.ts"]);
});

test("Storage reads mail in one module, and only through Mail's access check", () => {
  const importers = usersOf(/from "@cloudysuite\/mail\/access"/);
  expect(importers).toEqual(["apps/storage/src/mail-attachments.ts"]);
  expect(
    usersOf(/\bopenMailboxFor\(|\bopenMailbox\(/).filter((f) =>
      f.startsWith("apps/storage"),
    ),
  ).toEqual([]);
});

test("the package does not export the stub or the store", () => {
  expect(Object.keys(packageJson.exports).sort()).toEqual([
    ".",
    "./api",
    "./download",
    "./drive",
    "./routes",
  ]);
});
