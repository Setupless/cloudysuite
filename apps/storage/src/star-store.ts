import type { SqlDriver } from "@cloudysuite/object-sql";
import type { Actor, DriveStore } from "./store";
import type { ItemId, StarredLine, StarResult } from "./types";

export class StarStore {
  readonly #db: SqlDriver;
  readonly #store: DriveStore;

  constructor(db: SqlDriver, store: DriveStore) {
    this.#db = db;
    this.#store = store;
  }

  // Reaching an item is enough, so Can view can star. Saying it twice changes nothing.
  // Someone not on the drive may have opened it from a share with everyone, which D1 lists
  // nowhere, so the share index is told, to have Starred ask this drive.
  setStar(input: {
    actor: Actor;
    id: ItemId;
    on: boolean;
    now: number;
  }): StarResult {
    const { actor, id, on, now } = input;
    return this.#db.transaction((): StarResult => {
      if (!this.#store.reachOf(actor, id)) return { status: "noAccess" };
      if (!this.#store.item(id)) return { status: "gone" };
      if (on) {
        this.#db.exec(
          `INSERT INTO stars (user_id, item_id, starred_at) VALUES (?, ?, ?)
           ON CONFLICT (user_id, item_id) DO NOTHING`,
          actor.userId,
          id,
          now,
        );
      } else {
        this.#db.exec(
          "DELETE FROM stars WHERE user_id = ? AND item_id = ?",
          actor.userId,
          id,
        );
      }
      if (actor.role === null) {
        this.#store.queueIndexWrite(id, actor.userId, now);
      }
      return { status: "done" };
    });
  }

  starIds(actor: Actor): ItemId[] {
    return this.#db
      .exec<{ item_id: string }>(
        "SELECT item_id FROM stars WHERE user_id = ?",
        actor.userId,
      )
      .toArray()
      .map((row) => row.item_id as ItemId);
  }

  // A star on something this person can't reach any more, or that's in Trash, just isn't
  // listed. The row stays, so getting it back brings the star back.
  starred(actor: Actor, limit: number): StarredLine[] {
    return this.#db
      .exec<{ item_id: string; starred_at: number }>(
        `SELECT stars.item_id, stars.starred_at FROM stars
         JOIN items ON items.id = stars.item_id
         WHERE stars.user_id = ? AND items.trash_id IS NULL
         ORDER BY stars.starred_at DESC, stars.item_id LIMIT ?`,
        actor.userId,
        limit,
      )
      .toArray()
      .flatMap((row) => {
        const opened = this.#store.opened(actor, row.item_id as ItemId);
        return opened ? [{ ...opened, starredAt: row.starred_at }] : [];
      });
  }
}
