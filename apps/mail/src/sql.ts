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
