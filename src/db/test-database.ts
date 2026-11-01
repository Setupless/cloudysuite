import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dir, "../../migrations");

// An in-memory database built from the real migrations, behind the parts of
// the D1 API that Drizzle calls. It proves query behaviour, not D1 itself.
export function createTestDatabase(): { sqlite: Database; d1: D1Database } {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    sqlite.run(readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8"));
  }
  const prepare = (sql: string, params: never[] = []) => ({
    bind: (...next: never[]) => prepare(sql, next),
    all: async () => ({ results: sqlite.query(sql).all(...params) }),
    raw: async () => sqlite.query(sql).values(...params),
    run: async () => sqlite.query(sql).run(...params),
  });
  return { sqlite, d1: { prepare } as unknown as D1Database };
}
