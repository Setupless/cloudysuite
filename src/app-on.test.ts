import { expect, test } from "bun:test";
import { assertAppOn } from "./app-on";
import { createTestDatabase } from "./db/test-database";

async function refusalOf(run: Promise<void>) {
  const refusal = await run.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(refusal instanceof Response)) throw refusal ?? new Error("Not off");
  return {
    status: refusal.status,
    message: ((await refusal.json()) as { message: string }).message,
  };
}

test.each([
  ["mail", "storage", "turned Mail off"],
  ["storage", "mail", "turned Storage off"],
] as const)(
  "%s is on until its own row says off, then refused in plain words",
  async (app, other, words) => {
    const { sqlite, d1 } = createTestDatabase();
    await expect(assertAppOn(d1, app)).resolves.toBeUndefined();

    sqlite.run("INSERT INTO app_settings (app, enabled) VALUES (?, 0)", [
      other,
    ]);
    await expect(assertAppOn(d1, app)).resolves.toBeUndefined();

    sqlite.run("INSERT INTO app_settings (app, enabled) VALUES (?, 0)", [app]);
    const refused = await refusalOf(assertAppOn(d1, app));
    expect(refused.status).toBe(403);
    expect(refused.message).toContain(words);
  },
);
