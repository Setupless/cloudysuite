import type { SqlDriver } from "@cloudysuite/object-sql";
import { searchWords, toMatchExpression } from "./search-text";
import type { Actor, DriveStore } from "./store";
import type { ItemId, SearchLine, SearchResult } from "./types";

// Rows still arriving from another drive stay out until they unlock. The drive they came
// from is still answering for them, and they go if the move is given up. Rows on their way
// out stay in, because they're still here until the other drive has them.
const MATCHES = `items.rowid IN (SELECT rowid FROM item_search WHERE item_search MATCH ?)
  AND items.trash_id IS NULL
  AND (items.move_id IS NULL OR items.move_id NOT IN (SELECT id FROM moves_in))`;

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
  #matches(actor: Actor, expression: string, limit: number): string[] {
    const rows =
      actor.role !== null
        ? this.#db.exec<{ id: string }>(
            `SELECT items.id FROM items WHERE ${MATCHES}
             ORDER BY items.changed_at DESC, items.id LIMIT ?`,
            expression,
            limit,
          )
        : this.#db.exec<{ id: string }>(
            `WITH RECURSIVE reachable(id) AS (
               SELECT item_id FROM shares WHERE user_id = ?
               UNION
               SELECT items.id FROM items JOIN reachable ON items.parent_id = reachable.id
             )
             SELECT items.id FROM items
             WHERE ${MATCHES} AND items.id IN (SELECT id FROM reachable)
             ORDER BY items.changed_at DESC, items.id LIMIT ?`,
            actor.userId,
            expression,
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

  search(actor: Actor, text: string, limit: number): SearchResult {
    const words = searchWords(text);
    if (words.length === 0) return { lines: [], more: false };
    const ids = this.#matches(actor, toMatchExpression(words), limit + 1);
    return {
      lines: ids
        .slice(0, limit)
        .flatMap((id) => this.#line(actor, id as ItemId) ?? []),
      more: ids.length > limit,
    };
  }
}
