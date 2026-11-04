import type { SqlDriver, SqlValue } from "@cloudysuite/object-sql";
import { FILE_TYPE_RULES, FILE_TYPES } from "./file-types";
import {
  type DriveSearch,
  type ItemType,
  toMatchExpression,
} from "./search-query";
import type { Actor, DriveStore } from "./store";
import type { ItemId, SearchLine, SearchResult } from "./types";

// Rows still arriving from another drive stay out until they unlock. The drive they came
// from is still answering for them, and they go if the move is given up. Rows on their way
// out stay in, because they're still here until the other drive has them.
const FINDABLE = `items.trash_id IS NULL
  AND (items.move_id IS NULL OR items.move_id NOT IN (SELECT id FROM moves_in))`;

// The patterns are this code's own constants, so they go in the SQL as written. LIKE
// ignores the case of ASCII letters, as `fileTypeOf` does.
const endsWithAny = (extensions: readonly string[]) =>
  `(${extensions.map((extension) => `items.name LIKE '%.${extension}'`).join(" OR ")})`;

const ALL_EXTENSIONS = FILE_TYPES.flatMap(
  (type) => FILE_TYPE_RULES[type].extensions,
);

function typeCondition(type: ItemType): string {
  if (type === "folder") return "items.kind = 'folder'";
  const { extensions, mimePattern } = FILE_TYPE_RULES[type];
  const byMime =
    mimePattern === null
      ? ""
      : ` OR (NOT ${endsWithAny(ALL_EXTENSIONS)} AND items.mime_type LIKE '${mimePattern}')`;
  return `items.kind = 'file' AND (${endsWithAny(extensions)}${byMime})`;
}

type Condition = { sql: string; values: SqlValue[] };

function conditionsOf(actor: Actor, search: DriveSearch): Condition[] {
  const conditions: Condition[] = [{ sql: FINDABLE, values: [] }];
  const expression = toMatchExpression(search.terms);
  if (expression !== null) {
    conditions.push({
      sql: "items.rowid IN (SELECT rowid FROM item_search WHERE item_search MATCH ?)",
      values: [expression],
    });
  }
  if (search.type !== null) {
    conditions.push({ sql: typeCondition(search.type), values: [] });
  }
  if (search.starred) {
    conditions.push({
      sql: "items.id IN (SELECT item_id FROM stars WHERE user_id = ?)",
      values: [actor.userId],
    });
  }
  if (search.owners !== null) {
    conditions.push({
      sql: `items.created_by IN (${search.owners.map(() => "?").join(", ")})`,
      values: search.owners,
    });
  }
  if (search.changedAfter !== null) {
    conditions.push({
      sql: "items.changed_at >= ?",
      values: [search.changedAfter],
    });
  }
  if (search.changedBefore !== null) {
    conditions.push({
      sql: "items.changed_at < ?",
      values: [search.changedBefore],
    });
  }
  return conditions;
}

export class SearchStore {
  readonly #db: SqlDriver;
  readonly #store: DriveStore;

  constructor(db: SqlDriver, store: DriveStore) {
    this.#db = db;
    this.#store = store;
  }

  // Someone not on the drive searches only what was shared with them by name. A share
  // with everyone doesn't count: that opens for someone holding the link, and searching
  // it would tell the whole organisation what's in it.
  #matches(actor: Actor, search: DriveSearch, limit: number): string[] {
    const conditions = conditionsOf(actor, search);
    const where = conditions.map((condition) => condition.sql).join(" AND ");
    const values = conditions.flatMap((condition) => condition.values);
    const rows =
      actor.role !== null
        ? this.#db.exec<{ id: string }>(
            `SELECT items.id FROM items WHERE ${where}
             ORDER BY items.changed_at DESC, items.id LIMIT ?`,
            ...values,
            limit,
          )
        : this.#db.exec<{ id: string }>(
            `WITH RECURSIVE reachable(id) AS (
               SELECT item_id FROM shares WHERE user_id = ?
               UNION
               SELECT items.id FROM items JOIN reachable ON items.parent_id = reachable.id
             )
             SELECT items.id FROM items
             WHERE ${where} AND items.id IN (SELECT id FROM reachable)
             ORDER BY items.changed_at DESC, items.id LIMIT ?`,
            actor.userId,
            ...values,
            limit,
          );
    return rows.toArray().map((row) => row.id);
  }

  // The outermost share with this person at or above the item, for the same reason as
  // above: a folder above it with a share for everyone stays unnamed.
  #topShare(actor: Actor, id: ItemId): ItemId | null {
    const [row] = this.#db
      .exec<{ id: string }>(
        `WITH RECURSIVE chain(id, parent_id, depth) AS (
           SELECT id, parent_id, 0 FROM items WHERE id = ?
           UNION ALL
           SELECT items.id, items.parent_id, chain.depth + 1
           FROM items JOIN chain ON items.id = chain.parent_id
         )
         SELECT chain.id FROM chain
         JOIN shares ON shares.item_id = chain.id AND shares.user_id = ?
         ORDER BY chain.depth DESC LIMIT 1`,
        id,
        actor.userId,
      )
      .toArray();
    return (row?.id ?? null) as ItemId | null;
  }

  #line(actor: Actor, id: ItemId): SearchLine | null {
    if (!this.#store.reachOf(actor, id)) return null;
    const item = this.#store.item(id);
    if (!item) return null;
    const topId = actor.role === null ? this.#topShare(actor, id) : null;
    return {
      item: item.id === topId ? { ...item, parentId: null } : item,
      location: this.#store.ancestors(id, topId).map((folder) => folder.name),
    };
  }

  search(actor: Actor, search: DriveSearch, limit: number): SearchResult {
    if (search.owners?.length === 0) return { lines: [], more: false };
    const ids = this.#matches(actor, search, limit + 1);
    return {
      lines: ids
        .slice(0, limit)
        .flatMap((id) => this.#line(actor, id as ItemId) ?? []),
      more: ids.length > limit,
    };
  }
}
