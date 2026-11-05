// D1 binds at most 100 values in a statement, and each query that uses this binds a few
// more.
const CHUNK = 90;

// A list from an event, a team, or an email can be any length, so it's asked in parts,
// each one statement of a batch, which D1 counts as one query.
export function chunked<Item>(items: readonly Item[]): Item[][] {
  const unique = [...new Set(items)];
  const parts: Item[][] = [];
  for (let start = 0; start < unique.length; start += CHUNK) {
    parts.push(unique.slice(start, start + CHUNK));
  }
  return parts;
}
