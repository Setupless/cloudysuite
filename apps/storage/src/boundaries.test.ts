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

test("only stub.ts touches the drive binding", () => {
  expect(usersOf(/\benv\.DRIVE\b/)).toEqual(["apps/storage/src/stub.ts"]);
});

test("only the access-checked client imports the stub", () => {
  expect(
    usersOf(/from "[^"]*\/stub"/).filter((f) => f.includes("storage")),
  ).toEqual(["apps/storage/src/client.ts"]);
});

test("only the access check's own module opens a drive for a person", () => {
  expect(usersOf(/\bopenDrive\(/)).toEqual([
    "apps/storage/src/access.ts",
    "apps/storage/src/client.ts",
  ]);
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
  ]);
});
