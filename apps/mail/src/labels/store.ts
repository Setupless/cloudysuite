import type { RuleStore } from "../rules/store";
import type { SqlDriver } from "../sql";
import { type LabelColour, type LabelId, parseColour } from "../types";

export const MAX_LABELS = 500;
export const MAX_LABEL_NAME_LENGTH = 64;

export type Label = { id: LabelId; name: string; colour: LabelColour };

export type LabelWrite =
  | { ok: true; label: Label }
  | { ok: false; status: 404 | 409; message: string };

// Names are shown beside other people's mail. Characters that are invisible or
// that reorder text could make one label pass for another, so they go here.
// Default-ignorable characters (U+034F, zero-widths, variation selectors) are cut
// out rather than spaced, so `Work` and `Work` plus one of them are the same name.
export function cleanLabelName(raw: string): string | null {
  const name = raw
    .normalize("NFC")
    .replace(/\p{Default_Ignorable_Code_Point}+/gu, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name.length > 0 && name.length <= MAX_LABEL_NAME_LENGTH ? name : null;
}

const GONE = {
  ok: false,
  status: 404,
  message: "That label isn't here anymore.",
} as const;

export class LabelStore {
  readonly #db: SqlDriver;
  readonly #rules: RuleStore;

  constructor(db: SqlDriver, rules: RuleStore) {
    this.#db = db;
    this.#rules = rules;
  }

  #named(name: string, except: LabelId | null): boolean {
    return (
      this.#db
        .exec<{ id: number }>(
          "SELECT id FROM labels WHERE name = ? AND id IS NOT ?",
          name,
          except,
        )
        .toArray().length > 0
    );
  }

  #taken(name: string): LabelWrite {
    return {
      ok: false,
      status: 409,
      message: `You already have a label called "${name}".`,
    };
  }

  create(name: string, colour: LabelColour): LabelWrite {
    return this.#db.transaction(() => {
      if (this.#named(name, null)) return this.#taken(name);
      const [count] = this.#db
        .exec<{ total: number }>("SELECT COUNT(*) AS total FROM labels")
        .toArray();
      if ((count?.total ?? 0) >= MAX_LABELS) {
        return {
          ok: false,
          status: 409,
          message: `A mailbox can have up to ${MAX_LABELS} labels. Delete one you don't use, then try again.`,
        };
      }
      const [row] = this.#db
        .exec<{ id: number }>(
          "INSERT INTO labels (name, colour, created_at) VALUES (?, ?, ?) RETURNING id",
          name,
          colour,
          Date.now(),
        )
        .toArray();
      return { ok: true, label: { id: row!.id as LabelId, name, colour } };
    });
  }

  update(
    id: LabelId,
    change: { name?: string | undefined; colour?: LabelColour | undefined },
  ): LabelWrite {
    return this.#db.transaction(() => {
      if (change.name !== undefined && this.#named(change.name, id)) {
        return this.#taken(change.name);
      }
      const [row] = this.#db
        .exec<{ id: number; name: string; colour: string }>(
          `UPDATE labels SET name = COALESCE(?, name), colour = COALESCE(?, colour)
           WHERE id = ? RETURNING id, name, colour`,
          change.name ?? null,
          change.colour ?? null,
          id,
        )
        .toArray();
      if (!row) return GONE;
      return {
        ok: true,
        label: {
          id: row.id as LabelId,
          name: row.name,
          colour: parseColour(row.colour),
        },
      };
    });
  }

  // One set-based delete instead of a refresh per thread: a label can span a whole
  // mailbox, and nothing in a folder's rows mentions labels, so removing the label's
  // own rows leaves the read model exactly as a full refresh would. store.test.ts
  // holds it to that.
  delete(id: LabelId): void {
    this.#db.transaction(() => {
      this.#db.exec("DELETE FROM thread_views WHERE view = ?", `label:${id}`);
      this.#db.exec("DELETE FROM message_labels WHERE label_id = ?", id);
      this.#db.exec("DELETE FROM labels WHERE id = ?", id);
      this.#rules.forgetLabel(id);
    });
  }
}
