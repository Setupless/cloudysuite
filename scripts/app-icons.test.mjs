import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderAllIcons } from "./generate-app-icons.mjs";

test("the app icons match the theme's colours", () => {
  for (const { path, bytes } of renderAllIcons()) {
    const current = readFileSync(path);
    if (!current.equals(bytes)) {
      throw new Error(
        `${path} no longer matches the theme. Run: bun scripts/generate-app-icons.mjs`,
      );
    }
    expect(current.subarray(1, 4).toString()).toBe("PNG");
  }
});
