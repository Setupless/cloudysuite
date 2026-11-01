import { expect, test } from "bun:test";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { createSqlDriver } from "./test-support";

const versions = (db: ReturnType<typeof createSqlDriver>["db"]) =>
  db
    .exec<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    )
    .toArray()
    .map((row) => row.version);

test("running the migrations twice applies each one once", () => {
  const { db } = createSqlDriver();
  applyMigrations(db);
  db.exec("INSERT INTO threads (created_at) VALUES (1)");
  applyMigrations(db);
  expect(versions(db)).toEqual(MIGRATIONS.map((_, index) => index + 1));
  expect(db.exec("SELECT * FROM threads").toArray()).toHaveLength(1);
});

test("a later release applies only the new migration", () => {
  const { db } = createSqlDriver();
  applyMigrations(db, [["CREATE TABLE one (id INTEGER)"]]);
  applyMigrations(db, [
    ["CREATE TABLE one (id INTEGER)"],
    ["CREATE TABLE two (id INTEGER)", "CREATE TABLE three (id INTEGER)"],
  ]);
  expect(versions(db)).toEqual([1, 2]);
  expect(db.exec("SELECT * FROM three").toArray()).toEqual([]);
});

test("a failed migration leaves no part of itself behind and can run again", () => {
  const { db } = createSqlDriver();
  const broken = [["CREATE TABLE one (id INTEGER)", "NOT SQL"]];
  expect(() => applyMigrations(db, broken)).toThrow();
  expect(() => db.exec("SELECT * FROM one").toArray()).toThrow();

  applyMigrations(db, [["CREATE TABLE one (id INTEGER)"]]);
  expect(versions(db)).toEqual([1]);
});

test("released migrations do not change", async () => {
  const digests = await Promise.all(
    MIGRATIONS.map(async (statements) => {
      const bytes = new TextEncoder().encode(JSON.stringify(statements));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return new Uint8Array(digest).toHex();
    }),
  );
  expect(digests).toEqual([
    "64d76cc75a9c4fde8212b0e492e008d51d777bc8ff7397f0a6531049efb0bb04",
    "3521e4d8fa8b43d605caf0c3e41498076d269bbc497ac13f036966d1f90e2117",
    "e45855e92d326470830ff91d585e07ae4c4bb2ff1d7eb7709cab55c20382f42d",
    "3a0cc3e4d8dc3b4302a38bd5a8667cc13f545bbd91a4e1ced344d24748f08aef",
  ]);
});
