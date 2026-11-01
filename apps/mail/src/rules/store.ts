import type { SqlDriver, SqlRow } from "../sql";
import type { LabelId } from "../types";
import {
  hasAction,
  MAX_RULES,
  parseRuleDraft,
  type Rule,
  type RuleDraft,
  type RuleId,
  type RuleWrite,
} from "./types";

type RuleRow = SqlRow & {
  id: number;
  name: string;
  enabled: number;
  conditions: string;
  actions: string;
};

const GONE = {
  ok: false,
  status: 404,
  message: "That rule isn't here anymore.",
} as const;

function readRow(row: RuleRow): Rule | null {
  try {
    const { match, list } = JSON.parse(row.conditions) as {
      match: unknown;
      list: unknown;
    };
    const draft = parseRuleDraft({
      name: row.name,
      enabled: row.enabled === 1,
      match,
      conditions: list,
      actions: JSON.parse(row.actions),
    });
    return typeof draft === "string"
      ? null
      : { ...draft, id: row.id as RuleId };
  } catch {
    return null;
  }
}

export class RuleStore {
  readonly #db: SqlDriver;

  constructor(db: SqlDriver) {
    this.#db = db;
  }

  // A row that can't be read is left out, never thrown, so that it can't stop mail.
  #read(where: string): Rule[] {
    return this.#db
      .exec<RuleRow>(
        `SELECT id, name, enabled, conditions, actions FROM rules
         ${where} ORDER BY position, id`,
      )
      .toArray()
      .flatMap((row) => readRow(row) ?? []);
  }

  list(): Rule[] {
    return this.#read("");
  }

  enabled(): Rule[] {
    return this.#read("WHERE enabled = 1");
  }

  #labelIsGone(draft: RuleDraft): boolean {
    const { labelId } = draft.actions;
    if (labelId === null) return false;
    return (
      this.#db
        .exec<{ id: number }>("SELECT id FROM labels WHERE id = ?", labelId)
        .toArray().length === 0
    );
  }

  create(draft: RuleDraft): RuleWrite {
    return this.#db.transaction(() => {
      const [counts] = this.#db
        .exec<{ last: number | null }>(
          "SELECT MAX(position) AS last FROM rules",
        )
        .toArray();
      // Rows that can't be read are inert: nobody can see or delete them, so they
      // neither count toward the limit nor block a reorder.
      if (this.list().length >= MAX_RULES) {
        return {
          ok: false,
          status: 409,
          message: `A mailbox can have up to ${MAX_RULES} rules. Delete one you don't use, then try again.`,
        };
      }
      if (this.#labelIsGone(draft)) return labelGone();
      const [row] = this.#db
        .exec<{ id: number }>(
          `INSERT INTO rules (name, position, enabled, conditions, actions, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          draft.name,
          (counts?.last ?? 0) + 1,
          draft.enabled ? 1 : 0,
          JSON.stringify({ match: draft.match, list: draft.conditions }),
          JSON.stringify(draft.actions),
          Date.now(),
        )
        .toArray();
      return { ok: true, rule: { ...draft, id: row!.id as RuleId } };
    });
  }

  update(id: RuleId, draft: RuleDraft): RuleWrite {
    return this.#db.transaction(() => {
      if (this.#labelIsGone(draft)) return labelGone();
      const [row] = this.#db
        .exec<{ id: number }>(
          `UPDATE rules SET name = ?, enabled = ?, conditions = ?, actions = ?
           WHERE id = ? RETURNING id`,
          draft.name,
          draft.enabled ? 1 : 0,
          JSON.stringify({ match: draft.match, list: draft.conditions }),
          JSON.stringify(draft.actions),
          id,
        )
        .toArray();
      return row ? { ok: true, rule: { ...draft, id } } : GONE;
    });
  }

  delete(id: RuleId): void {
    this.#db.exec("DELETE FROM rules WHERE id = ?", id);
  }

  // Takes the whole order, so a page that is out of date can't half-apply one. False
  // means the ids aren't this mailbox's rules any more.
  reorder(ids: RuleId[]): boolean {
    return this.#db.transaction(() => {
      const current = this.list().map((rule) => rule.id);
      const same =
        ids.length === current.length &&
        new Set(ids).size === ids.length &&
        ids.every((id) => current.includes(id));
      if (!same) return false;
      ids.forEach((id, position) => {
        this.#db.exec(
          "UPDATE rules SET position = ? WHERE id = ?",
          position + 1,
          id,
        );
      });
      return true;
    });
  }

  // A rule left with nothing to do turns itself off, and the Rules page says why.
  forgetLabel(labelId: LabelId): void {
    for (const rule of this.list()) {
      if (rule.actions.labelId !== labelId) continue;
      const actions = { ...rule.actions, labelId: null };
      this.#db.exec(
        "UPDATE rules SET actions = ?, enabled = ? WHERE id = ?",
        JSON.stringify(actions),
        rule.enabled && hasAction(actions) ? 1 : 0,
        rule.id,
      );
    }
  }
}

const labelGone = (): RuleWrite => ({
  ok: false,
  status: 409,
  message: "That label isn't here anymore. Choose another one.",
});
