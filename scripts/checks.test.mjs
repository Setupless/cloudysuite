import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const dirs = [];

function run(script, options = {}) {
  const result = Bun.spawnSync(["bun", join(ROOT, "scripts", script)], {
    stderr: "pipe",
    ...options,
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

function themeCheckWith(path, text) {
  const dir = mkdtempSync(join(tmpdir(), "cloudysuite-"));
  dirs.push(dir);
  cpSync(
    join(ROOT, "src/styles/theme.css"),
    join(dir, "src/styles/theme.css"),
    {
      recursive: true,
    },
  );
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), text);
  return run("check-theme.mjs", { cwd: dir });
}

function prCheck(PR_BRANCH, PR_TITLE) {
  return run("check-pr.mjs", { env: { ...process.env, PR_BRANCH, PR_TITLE } });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

test.each(["src/a.ts", "apps/mail/src/a.ts", "packages/ui/src/a.ts"])(
  "theme check rejects a raw colour in %s",
  (path) => {
    const { code, stderr } = themeCheckWith(path, 'const c = "#ff0000";');
    expect(code).toBe(1);
    expect(stderr).toContain(path);
  },
);

test.each(["node_modules/dep", "dist", ".output", ".wrangler/tmp"])(
  "theme check ignores generated files in %s",
  (dir) => {
    const path = `apps/mail/${dir}/a.js`;
    expect(themeCheckWith(path, 'const c = "#ff0000";').code).toBe(0);
  },
);

test.each([
  ["feat/mail-labels", "feat(mail): add labels"],
  ["fix/login", "fix: reject expired invite tokens"],
])("PR check accepts %s with title %s", (branch, title) => {
  expect(prCheck(branch, title).code).toBe(0);
});

test.each([
  ["my-branch", "feat: add labels"],
  ["feat/Mail_Labels", "feat: add labels"],
  ["feat/mail-labels", "Add labels"],
  ["feat/mail-labels", "feature: add labels"],
])("PR check rejects %s with title %s", (branch, title) => {
  expect(prCheck(branch, title).code).toBe(1);
});
