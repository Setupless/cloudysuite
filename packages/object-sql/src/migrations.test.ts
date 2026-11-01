import { expect, test } from "bun:test";
import { applyMigrations } from "./index";
import { createSqlDriver } from "./test-driver";

const versions = (db: ReturnType<typeof createSqlDriver>["db"]) =>
  db
    .exec<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    )
    .toArray()
    .map((row) => row.version);

test("running the migrations twice applies each one once", () => {
  const { db } = createSqlDriver();
  const migrations = [["CREATE TABLE one (id INTEGER)"]];
  applyMigrations(db, migrations);
  db.exec("INSERT INTO one (id) VALUES (1)");
  applyMigrations(db, migrations);
  expect(versions(db)).toEqual([1]);
  expect(db.exec("SELECT * FROM one").toArray()).toHaveLength(1);
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
