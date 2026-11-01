import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appManifest, themeColour } from "./manifest";

const THEME = readFileSync(
  join(import.meta.dir, "../../../../src/styles/theme.css"),
  "utf8",
);

test("the manifest's colours come from the theme", () => {
  const manifest = appManifest(`
    --color-page: light-dark(first, second);
    --color-accent: single;
  `);
  expect(manifest.theme_color).toBe("first");
  expect(manifest.background_color).toBe("first");
});

test("the real theme has the role the manifest reads", () => {
  expect(appManifest(THEME).theme_color).toBe(themeColour(THEME, "page"));
  expect(themeColour(THEME, "page")).toBeTruthy();
});

test("a role missing from the theme stops the build", () => {
  expect(() => themeColour("--color-text: single;", "page")).toThrow();
});

test("the app can be installed: its own scope, a window, and every icon size", () => {
  const manifest = appManifest(THEME);
  expect(manifest.scope).toBe("/");
  expect(manifest.start_url).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.map((icon) => icon.sizes)).toContain("192x192");
  expect(manifest.icons.map((icon) => icon.sizes)).toContain("512x512");
  expect(manifest.icons.map((icon) => icon.purpose)).toContain("maskable");
});
