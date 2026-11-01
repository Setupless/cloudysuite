import type { SqlDriver, SqlRow, SqlValue } from "../sql";
import {
  describeMembers,
  encodeCursor,
  type MailboxStore,
  parseCursor,
  type ViewSourceRow,
} from "../store";
import type { LabelId, ThreadPage, ThreadSummary } from "../types";
import { parseSearch, type SearchQuery, toMatchExpression } from "./query";

const PAGE_SIZE = 50;

export type SearchInput = {
  text: string;
  offsetMinutes: number;
  cursor?: string | undefined;
};

export type SearchPage = ThreadPage & { problem: string | null };

type HitRow = SqlRow & { thread_id: number; last_at: number; hit_id: number };
type MemberRow = ViewSourceRow & { thread_id: number };

const nothing = (problem: string | null): SearchPage => ({
  threads: [],
  nextCursor: null,
  problem,
});

function folderScope(query: SearchQuery): { sql: string; binds: SqlValue[] } {
  return query.folder
    ? { sql: "m.folder = ?", binds: [query.folder] }
    : { sql: "m.folder NOT IN ('spam', 'trash')", binds: [] };
}

export class SearchStore {
  readonly #db: SqlDriver;
  readonly #store: MailboxStore;

  constructor(db: SqlDriver, store: MailboxStore) {
    this.#db = db;
    this.#store = store;
  }

  #labelIds(names: string[]): { ids: LabelId[]; missing: string | null } {
    const ids: LabelId[] = [];
    for (const name of names) {
      const [row] = this.#db
        .exec<{ id: number }>("SELECT id FROM labels WHERE name = ?", name)
        .toArray();
      if (!row) return { ids, missing: name };
      ids.push(row.id as LabelId);
    }
    return { ids, missing: null };
  }

  // Finds matching messages, then shows their conversations. A row sorts and reads
  // by its newest match, so the snippet is from a message that really matched, and
  // its other facts cover the conversation's messages within the same folders.
  search({ text, offsetMinutes, cursor }: SearchInput): SearchPage {
    const parsed = parseSearch(text, offsetMinutes);
    if (!parsed.ok) return nothing(parsed.problem);
    const { query } = parsed;
    const labels = this.#labelIds(query.labels);
    if (labels.missing !== null) {
      return nothing(`You don't have a label called "${labels.missing}".`);
    }

    const scope = folderScope(query);
    const conditions = [scope.sql];
    const binds: SqlValue[] = [...scope.binds];
    const expression = toMatchExpression(query.terms);
    if (expression) {
      conditions.push(
        "m.id IN (SELECT rowid FROM message_search WHERE message_search MATCH ?)",
      );
      binds.push(expression);
    }
    if (query.hasAttachment) conditions.push("m.has_attachments = 1");
    if (query.unread) conditions.push("m.is_read = 0");
    if (query.starred) conditions.push("m.is_starred = 1");
    for (const id of labels.ids) {
      conditions.push(
        "m.id IN (SELECT message_id FROM message_labels WHERE label_id = ?)",
      );
      binds.push(id);
    }
    if (query.receivedBefore !== null) {
      conditions.push("m.received_at < ?");
      binds.push(query.receivedBefore);
    }
    if (query.receivedAfter !== null) {
      conditions.push("m.received_at >= ?");
      binds.push(query.receivedAfter);
    }

    const position = parseCursor(cursor);
    const hits = this.#db
      .exec<HitRow>(
        `SELECT thread_id, last_at, hit_id FROM (
           SELECT m.thread_id AS thread_id, MAX(m.received_at) AS last_at, m.id AS hit_id
           FROM messages m WHERE ${conditions.join(" AND ")}
           GROUP BY m.thread_id
         )
         WHERE ? IS NULL OR (last_at, thread_id) < (?, ?)
         ORDER BY last_at DESC, thread_id DESC
         LIMIT ?`,
        ...binds,
        position ? 1 : null,
        position?.lastAt ?? null,
        position?.threadId ?? null,
        PAGE_SIZE + 1,
      )
      .toArray();
    const page = hits.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      threads: this.#rows(page, scope),
      nextCursor:
        hits.length > PAGE_SIZE && last
          ? encodeCursor(last.last_at, last.thread_id)
          : null,
      problem: null,
    };
  }

  #rows(
    hits: HitRow[],
    scope: { sql: string; binds: SqlValue[] },
  ): ThreadSummary[] {
    if (hits.length === 0) return [];
    const threadIds = hits.map((hit) => hit.thread_id);
    const members = Map.groupBy(
      this.#db
        .exec<MemberRow>(
          `SELECT m.id, m.thread_id, m.folder, m.subject, m.snippet, m.from_name,
                  m.from_address, m.received_at, m.is_read, m.is_starred,
                  m.has_attachments
           FROM messages m
           WHERE m.thread_id IN (SELECT value FROM json_each(?)) AND ${scope.sql}
           ORDER BY m.thread_date, m.id`,
          JSON.stringify(threadIds),
          ...scope.binds,
        )
        .toArray(),
      (row) => row.thread_id,
    );
    const facts = this.#store.threadFacts(threadIds);
    return hits.map((hit) => {
      const inScope = members.get(hit.thread_id) ?? [];
      return {
        id: hit.thread_id,
        ...describeMembers(inScope),
        lastMessageAt: hit.last_at,
        snippet: inScope.find((row) => row.id === hit.hit_id)?.snippet ?? "",
        folders: [...new Set(inScope.map((row) => row.folder))],
        labelIds: facts.get(hit.thread_id)?.labelIds ?? [],
      } as ThreadSummary;
    });
  }
}
