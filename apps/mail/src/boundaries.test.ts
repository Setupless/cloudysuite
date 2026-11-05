import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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

test("only stub.ts touches the mailbox binding", () => {
  const users = productionFiles()
    .filter((file) => /\bMAILBOX\b/.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file));
  expect(users).toEqual(["apps/mail/src/stub.ts"]);
});

// Other apps have stubs of their own, each with its own test, so an import counts only
// when it resolves to Mail's.
test("only the access-checked client and ingest import the stub", () => {
  const mailStub = join(ROOT, "apps/mail/src/stub");
  const users = productionFiles()
    .filter((file) =>
      [...readFileSync(file, "utf8").matchAll(/from "([^"]*\/stub)"/g)].some(
        ([, path]) =>
          path?.startsWith(".") && join(dirname(file), path) === mailStub,
      ),
    )
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

test("Mail's code reaches the sign-in rule only through the Mail-on check", () => {
  const users = productionFiles()
    .filter((file) =>
      /\brequire(Ready|SignedIn|Admin)User\(/.test(readFileSync(file, "utf8")),
    )
    .map((file) => relative(ROOT, file))
    .filter((file) => file.startsWith("apps/mail/"))
    .sort();
  // The device session answers while Mail is off, and returns no mail.
  expect(users).toEqual([
    "apps/mail/src/access.ts",
    "apps/mail/src/pwa/session-route.ts",
  ]);
});

test("the package does not export the stub or the store", () => {
  expect(Object.keys(packageJson.exports).sort()).toEqual([
    ".",
    "./access",
    "./client",
    "./compose-api",
    "./device-session",
    "./download",
    "./import",
    "./import-api",
    "./ingest",
    "./mailbox",
    "./routes",
    "./send-outcome",
  ]);
});
