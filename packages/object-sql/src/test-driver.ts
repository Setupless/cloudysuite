import { Database } from "bun:sqlite";
import type { SqlDriver, SqlValue } from "./index";

// A Durable Object refuses a query that binds more than this, which SQLite here allows.
const MAX_BOUND_PARAMETERS = 100;

export function createSqlDriver(): { db: SqlDriver; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db: SqlDriver = {
    exec: <Row>(query: string, ...bindings: SqlValue[]) => {
      if (bindings.length > MAX_BOUND_PARAMETERS) {
        throw new Error("too many SQL variables: SQLITE_ERROR");
      }
      const rows = sqlite.prepare(query).all(...(bindings as never[])) as Row[];
      return { toArray: () => rows };
    },
    transaction: (body) => sqlite.transaction(body)(),
  } as SqlDriver;
  return { db, sqlite };
}
