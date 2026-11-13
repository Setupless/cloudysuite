import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dir, "../../migrations");

// What `env` from "cloudflare:workers" is under test. Bun loads each module once per run,
// so a module that read `env` when it first loaded keeps that object for the whole run.
// Every test support has to hand out this one object.
export const testWorkerEnv = {} as Env;

// D1 refuses a query that binds more than this, which SQLite here would allow.
const MAX_BOUND_PARAMETERS = 100;

// An in-memory database built from the real migrations, behind the parts of
// the D1 API that Drizzle calls. It proves query behaviour, not D1 itself.
export function createTestDatabase(): { sqlite: Database; d1: D1Database } {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    sqlite.run(readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8"));
  }
  const query = (sql: string, params: never[]) => {
    if (params.length > MAX_BOUND_PARAMETERS) {
      throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
    }
    return sqlite.query(sql);
  };
  const prepare = (sql: string, params: never[] = []) => ({
    sql,
    params,
    bind: (...next: never[]) => prepare(sql, next),
    all: async () => ({ results: query(sql, params).all(...params) }),
    raw: async () => query(sql, params).values(...params),
    run: async () => query(sql, params).run(...params),
  });
  // D1 runs a batch as one transaction, so one failed statement undoes them all.
  const batch = async (statements: ReturnType<typeof prepare>[]) =>
    sqlite.transaction(() =>
      statements.map(({ sql, params }) => ({
        results: query(sql, params).all(...params),
      })),
    )();
  return { sqlite, d1: { prepare, batch } as unknown as D1Database };
}
