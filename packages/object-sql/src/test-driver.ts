import { Database } from "bun:sqlite";
import type { SqlDriver, SqlValue } from "./index";

export function createSqlDriver(): { db: SqlDriver; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  const db: SqlDriver = {
    exec: <Row>(query: string, ...bindings: SqlValue[]) => {
      const rows = sqlite.prepare(query).all(...(bindings as never[])) as Row[];
      return { toArray: () => rows };
    },
    transaction: (body) => sqlite.transaction(body)(),
  } as SqlDriver;
  return { db, sqlite };
}
