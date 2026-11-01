import { expect, test } from "bun:test";
import { createTestDatabase } from "../../../src/db/test-database";
import { assertStorageOn, STORAGE_OFF_MESSAGE } from "./app-on";

test("a missing row means on, and a row saying off refuses in plain words", async () => {
  const { sqlite, d1 } = createTestDatabase();
  await expect(assertStorageOn(d1)).resolves.toBeUndefined();

  sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('mail', 0)");
  await expect(assertStorageOn(d1)).resolves.toBeUndefined();

  sqlite.run("INSERT INTO app_settings (app, enabled) VALUES ('storage', 0)");
  const refusal = await assertStorageOn(d1).catch((failure) => failure);
  expect(refusal).toBeInstanceOf(Response);
  expect(refusal.status).toBe(403);
  expect(await refusal.json()).toEqual({ message: STORAGE_OFF_MESSAGE });
});
