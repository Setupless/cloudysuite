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

test("only stub.ts touches the mailbox binding", () => {
  const users = productionFiles()
    .filter((file) => /\bMAILBOX\b/.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file));
  expect(users).toEqual(["apps/mail/src/stub.ts"]);
});

test("only the access-checked client and ingest import the stub", () => {
  const users = productionFiles()
    .filter((file) => /from "[^"]*\/stub"/.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file))
    .sort();
  expect(users).toEqual(["apps/mail/src/client.ts", "apps/mail/src/ingest.ts"]);
});

test("only the access check's own module opens a mailbox for a person", () => {
  const users = productionFiles()
    .filter((file) => /\bopenMailbox\(/.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file))
    .sort();
  expect(users).toEqual(["apps/mail/src/access.ts", "apps/mail/src/client.ts"]);
});

test("the package does not export the stub or the store", () => {
  expect(Object.keys(packageJson.exports).sort()).toEqual([
    ".",
    "./client",
    "./download",
    "./import",
    "./import-api",
    "./ingest",
    "./mailbox",
  ]);
});
