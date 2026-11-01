import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const THEME_PATH = "src/styles/theme.css";
const AA_TEXT = 4.5;

const AVATARS = [1, 2, 3, 4, 5, 6].map((n) => [`on-avatar`, `avatar-${n}`]);

const TEXT_PAIRS = [
  ...["page", "sidebar", "panel", "field", "selected"].flatMap((surface) => [
    ["text", surface],
    ["secondary", surface],
  ]),
  ...["page", "sidebar", "panel", "selected"].flatMap((surface) =>
    ["accent", "danger", "success", "tag-1", "tag-2"].map((color) => [
      color,
      surface,
    ]),
  ),
  ["on-accent", "accent"],
  ["page", "text"],
  ...AVATARS,
];

const REQUIRED_ROLES = [...new Set(TEXT_PAIRS.flat()), "line"];
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/i;
const SOURCE_FILE = /\.(css|tsx?|jsx?)$/;
const GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  ".output",
  ".wrangler",
]);

function parseTheme(css) {
  const roles = new Map();
  const errors = [];
  for (const [line, name, value] of css
    .matchAll(/^\s*(--color-([\w-]+)):\s*([^;]+);/gm)
    .map((m) => [m[1], m[2], m[3].trim()])) {
    const pair = value.match(
      /^light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)$/i,
    );
    const single = value.match(/^#[0-9a-f]{6}$/i);
    if (pair) roles.set(name, { light: pair[1], dark: pair[2] });
    else if (single) roles.set(name, { light: value, dark: value });
    else
      errors.push(
        `${line}: use a 6-digit hex or light-dark() with two, got "${value}"`,
      );
  }
  return { roles, errors };
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (GENERATED_DIRS.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return SOURCE_FILE.test(name) ? [path] : [];
  });
}

const { roles, errors } = parseTheme(readFileSync(THEME_PATH, "utf8"));

for (const role of REQUIRED_ROLES) {
  if (!roles.has(role))
    errors.push(`--color-${role}: missing from ${THEME_PATH}`);
}

let lowest = { ratio: Number.POSITIVE_INFINITY };
for (const mode of ["light", "dark"]) {
  for (const [fg, bg] of TEXT_PAIRS) {
    if (!roles.has(fg) || !roles.has(bg)) continue;
    const ratio = contrast(roles.get(fg)[mode], roles.get(bg)[mode]);
    if (ratio < lowest.ratio)
      lowest = { ratio, label: `${fg} on ${bg}, ${mode}` };
    if (ratio < AA_TEXT)
      errors.push(
        `${fg} on ${bg}, ${mode}: ${ratio.toFixed(2)} is below ${AA_TEXT}`,
      );
  }
}

for (const file of ["src", "apps", "packages"].flatMap(sourceFiles)) {
  if (file === THEME_PATH) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, index) => {
      if (COLOR_LITERAL.test(text))
        errors.push(
          `${file}:${index + 1}: use a --color- role, not a colour value`,
        );
      if (text.includes("app.css?url"))
        errors.push(
          `${file}:${index + 1}: import app.css directly, without ?url`,
        );
    });
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(`\nTheme check failed with ${errors.length} problem(s).`);
  process.exit(1);
}

console.log(
  `Theme check passed. ${roles.size} roles, ${TEXT_PAIRS.length * 2} pairs. Lowest contrast ${lowest.ratio.toFixed(2)} (${lowest.label}).`,
);
