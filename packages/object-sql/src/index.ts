export type SqlValue = string | number | null | ArrayBuffer;

export type SqlRow = Record<string, SqlValue>;

// The part of Durable Object SQLite this code uses, so that bun:sqlite can stand
// in for it in tests.
export type SqlDriver = {
  exec<Row extends SqlRow>(
    query: string,
    ...bindings: SqlValue[]
  ): { toArray(): Row[] };
  transaction<Result>(body: () => Result): Result;
};

// A migration list is append only: an object that ran a migration never runs it
// again, so editing one would leave objects with different schemas. Each app's list
// has a test that pins the digest of every entry.
export type Migrations = readonly (readonly string[])[];

export function applyMigrations(db: SqlDriver, migrations: Migrations): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
    const [latest] = db
      .exec<{ version: number | null }>(
        "SELECT MAX(version) AS version FROM schema_migrations",
      )
      .toArray();
    migrations.slice(latest?.version ?? 0).forEach((statements, index) => {
      for (const statement of statements) db.exec(statement);
      db.exec(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        (latest?.version ?? 0) + index + 1,
        Date.now(),
      );
    });
  });
}

export async function migrationDigests(
  migrations: Migrations,
): Promise<string[]> {
  return Promise.all(
    migrations.map(async (statements) => {
      const bytes = new TextEncoder().encode(JSON.stringify(statements));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return new Uint8Array(digest).toHex();
    }),
  );
}
