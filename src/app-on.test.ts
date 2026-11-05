import { expect, test } from "bun:test";
import { assertAppOn } from "./app-on";
import { createTestDatabase } from "./db/test-database";
import type { ToggleableApp } from "./routing";
import { readSettings } from "./settings";

async function refusalOf(database: D1Database, app: ToggleableApp) {
  try {
    assertAppOn(await readSettings(database), app);
    return null;
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    return {
      status: thrown.status,
      message: ((await thrown.json()) as { message: string }).message,
    };
  }
}

test.each([
  ["mail", "storage", "turned Mail off"],
  ["storage", "mail", "turned Storage off"],
  ["calendar", "storage", "turned Calendar off"],
] as const)(
  "%s is on until its own row says off, then refused in plain words",
  async (app, other, words) => {
    const { sqlite, d1 } = createTestDatabase();
    expect(await refusalOf(d1, app)).toBeNull();

    sqlite.run("INSERT INTO app_settings (app, enabled) VALUES (?, 0)", [
      other,
    ]);
    expect(await refusalOf(d1, app)).toBeNull();

    sqlite.run("INSERT INTO app_settings (app, enabled) VALUES (?, 0)", [app]);
    const refused = await refusalOf(d1, app);
    expect(refused?.status).toBe(403);
    expect(refused?.message).toContain(words);
  },
);
