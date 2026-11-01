import { type Placement, placementFor } from "./placement";
import type { SqlDriver, SqlRow } from "./sql";
import {
  normalizeSubject,
  participantsOf,
  sameConversation,
  SUBJECT_FALLBACK_WINDOW_MS,
} from "./threading";
import { FOLDERS, liveFolders, parseColour } from "./types";
import type {
  Address,
  AttachmentId,
  AttachmentInfo,
  AttachmentRef,
  AuthResults,
  BodyKind,
  BodyRef,
  CommitResult,
  Folder,
  LabelId,
  MailboxSummary,
  MessageDetail,
  MessageFlags,
  MessageId,
  MessageRef,
  MessageSelection,
  MessageSource,
  NewMessage,
  ParseStatus,
  ThreadDetail,
  ThreadId,
  ThreadPage,
  ThreadQuery,
  ThreadSummary,
  ThreadView,
} from "./types";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_SENDERS_IN_VIEW = 5;
const MAX_SUBJECT_CANDIDATES = 100;
export const DELETION_SETTLE_MS = 5 * 60 * 1000;

type RefRow = SqlRow & { id: number; thread_id: number; folder: Folder };

type MessageRow = SqlRow & {
  id: number;
  thread_id: number;
  rfc_message_id: string | null;
  refs: string;
  from_name: string | null;
  from_address: string | null;
  reply_to: string;
  to_addresses: string;
  cc_addresses: string;
  subject: string | null;
  snippet: string;
  sent_at: number | null;
  received_at: number;
  is_read: number;
  is_starred: number;
  folder: Folder;
  source: MessageSource;
  envelope_to: string | null;
  parse_status: ParseStatus;
  auth_results: string | null;
};

type AttachmentRow = SqlRow & {
  id: number;
  message_id: number;
  filename: string | null;
  mime_type: string;
  is_inline: number;
  content_id: string | null;
  size: number;
  r2_key: string;
};

type ViewRow = SqlRow & {
  thread_id: number;
  last_at: number;
  subject: string | null;
  snippet: string;
  senders: string;
  message_count: number;
  unread_count: number;
  is_starred: number;
  has_attachments: number;
};

export type ViewSourceRow = SqlRow & {
  id: number;
  folder: Folder;
  subject: string | null;
  snippet: string;
  from_name: string | null;
  from_address: string | null;
  received_at: number;
  is_read: number;
  is_starred: number;
  has_attachments: number;
};

type ViewKey = `folder:${Folder}` | `label:${number}`;

const viewKey = (view: ThreadView): ViewKey =>
  "folder" in view ? `folder:${view.folder}` : `label:${view.labelId}`;

const addressOf = (name: string | null, address: string | null) =>
  address === null ? null : { name: name ?? "", address };

const toRef = (row: RefRow): MessageRef => ({
  messageId: row.id as MessageId,
  threadId: row.thread_id as ThreadId,
  folder: row.folder,
});

function toAttachmentInfo(row: AttachmentRow): AttachmentInfo {
  return {
    id: row.id as AttachmentId,
    filename: row.filename,
    mimeType: row.mime_type,
    inline: row.is_inline === 1,
    contentId: row.content_id,
    size: row.size,
  };
}

function toMessageDetail(
  row: MessageRow,
  labelIds: LabelId[],
  attachments: AttachmentInfo[],
): MessageDetail {
  return {
    id: row.id as MessageId,
    threadId: row.thread_id as ThreadId,
    rfcMessageId: row.rfc_message_id,
    references: JSON.parse(row.refs) as string[],
    from: addressOf(row.from_name, row.from_address),
    replyTo: JSON.parse(row.reply_to) as Address[],
    to: JSON.parse(row.to_addresses) as Address[],
    cc: JSON.parse(row.cc_addresses) as Address[],
    subject: row.subject,
    snippet: row.snippet,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    read: row.is_read === 1,
    starred: row.is_starred === 1,
    folder: row.folder,
    source: row.source,
    envelopeTo: row.envelope_to,
    parseStatus: row.parse_status,
    authResults: row.auth_results
      ? (JSON.parse(row.auth_results) as AuthResults)
      : null,
    labelIds,
    attachments,
  };
}

export type ThreadFacts = { folders: Folder[]; labelIds: LabelId[] };

function toSummary(
  row: ViewRow,
  facts: ThreadFacts | undefined,
): ThreadSummary {
  return {
    id: row.thread_id as ThreadId,
    subject: row.subject,
    snippet: row.snippet,
    senders: JSON.parse(row.senders) as Address[],
    lastMessageAt: row.last_at,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    starred: row.is_starred === 1,
    hasAttachments: row.has_attachments === 1,
    folders: facts?.folders ?? [],
    labelIds: facts?.labelIds ?? [],
  };
}

export const encodeCursor = (lastAt: number, threadId: number) =>
  `${lastAt}_${threadId}`;

export function parseCursor(
  cursor: string | undefined,
): { lastAt: number; threadId: number } | null {
  const match = /^(-?\d{1,16})_(\d{1,16})$/.exec(cursor ?? "");
  return match
    ? { lastAt: Number(match[1]), threadId: Number(match[2]) }
    : null;
}

function senderList(rows: ViewSourceRow[]): Address[] {
  const seen = new Map<string, Address>();
  for (const row of rows.toReversed()) {
    const sender = addressOf(row.from_name, row.from_address);
    if (sender && !seen.has(sender.address.toLowerCase())) {
      seen.set(sender.address.toLowerCase(), sender);
    }
    if (seen.size === MAX_SENDERS_IN_VIEW) break;
  }
  return [...seen.values()];
}

// What a list row says about some of a thread's messages, given oldest first.
export function describeMembers(members: ViewSourceRow[]) {
  const latest = members.reduce((a, b) =>
    b.received_at >= a.received_at ? b : a,
  );
  return {
    lastMessageAt: latest.received_at,
    subject: members[0]!.subject,
    snippet: latest.snippet,
    senders: senderList(members),
    messageCount: members.length,
    unreadCount: members.filter((row) => row.is_read === 0).length,
    starred: members.some((row) => row.is_starred === 1),
    hasAttachments: members.some((row) => row.has_attachments === 1),
  };
}

// Every query for a mailbox lives here. The Durable Object adds transport, and
// access is checked before a caller can reach it (see client.ts).
export class MailboxStore {
  readonly #db: SqlDriver;

  constructor(db: SqlDriver) {
    this.#db = db;
  }

  findByHash(rawHash: string): MessageRef | null {
    const [row] = this.#db
      .exec<RefRow>(
        "SELECT id, thread_id, folder FROM messages WHERE raw_hash = ?",
        rawHash,
      )
      .toArray();
    return row ? toRef(row) : null;
  }

  commit(message: NewMessage): CommitResult {
    return this.#db.transaction(() => {
      const existing = this.findByHash(message.rawHash);
      if (existing) {
        // The losing copy's objects are its own, unless this is the winner's
        // commit arriving twice, and then they are the message's only copy.
        if (this.storagePrefix(existing.messageId) !== message.r2Prefix) {
          this.queueDeletion(message.r2Prefix);
        }
        return { status: "duplicate", ...existing };
      }

      const placement = placementFor(message, this.#db);
      const threadId = this.#assignThread(message);
      const messageId = this.#insertMessage(message, threadId, placement);
      this.#db.exec(
        `INSERT OR IGNORE INTO message_labels (message_id, label_id)
         SELECT ?, id FROM labels WHERE id IN (SELECT value FROM json_each(?))`,
        messageId,
        JSON.stringify(placement.labelIds),
      );
      // A reply stays in the conversation's labels, or a labelled conversation
      // would go quiet in its own label view.
      this.#db.exec(
        `INSERT OR IGNORE INTO message_labels (message_id, label_id)
         SELECT DISTINCT ?, ml.label_id FROM message_labels ml
         JOIN messages m ON m.id = ml.message_id WHERE m.thread_id = ?`,
        messageId,
        threadId,
      );
      this.refreshThread(threadId);
      return {
        status: "stored",
        messageId,
        threadId,
        folder: placement.folder,
      };
    });
  }

  // A message's thread is its connected component in a graph that does not depend
  // on arrival order: messages link through shared RFC ids and through the subject
  // fallback. A newcomer that bridges two threads merges them, so any order of
  // arrival ends with the same groups.
  #assignThread(message: NewMessage): ThreadId {
    const keys = [
      ...new Set([
        ...(message.rfcMessageId ? [message.rfcMessageId] : []),
        ...message.references,
      ]),
    ];
    const keysJson = JSON.stringify(keys);
    const linked = new Set<number>();
    for (const row of this.#db
      .exec<{ thread_id: number }>(
        "SELECT DISTINCT thread_id FROM thread_refs WHERE rfc_id IN (SELECT value FROM json_each(?))",
        keysJson,
      )
      .toArray()) {
      linked.add(row.thread_id);
    }
    for (const id of this.#threadsBySubject(message)) linked.add(id);

    const [survivor, ...merged] = [...linked].sort((a, b) => a - b);
    const threadId = survivor ?? this.#createThread(message.receivedAt);
    for (const id of merged) {
      this.#db.exec(
        "UPDATE messages SET thread_id = ? WHERE thread_id = ?",
        threadId,
        id,
      );
      this.#db.exec(
        "UPDATE thread_refs SET thread_id = ? WHERE thread_id = ?",
        threadId,
        id,
      );
      this.#db.exec("DELETE FROM threads WHERE id = ?", id);
    }
    this.#db.exec(
      `INSERT INTO thread_refs (rfc_id, thread_id)
       SELECT value, ? FROM json_each(?) WHERE true
       ON CONFLICT (rfc_id) DO UPDATE SET thread_id = excluded.thread_id`,
      threadId,
      keysJson,
    );
    return threadId as ThreadId;
  }

  #createThread(createdAt: number): number {
    const [row] = this.#db
      .exec<{ id: number }>(
        "INSERT INTO threads (created_at) VALUES (?) RETURNING id",
        createdAt,
      )
      .toArray();
    return row!.id;
  }

  // Only a reply with no threading headers, from a client that dropped them, can
  // link by subject. Two plain "hello" mails never join, however close in time.
  #threadsBySubject(message: NewMessage): number[] {
    const { normalized, isReply } = normalizeSubject(message.subject);
    if (!normalized) return [];
    const isOrphan = isReply && message.references.length === 0;
    const date = message.sentAt ?? message.receivedAt;
    const facts = {
      from: message.from?.address.toLowerCase() ?? null,
      participants: participantsOf(message),
    };
    return this.#db
      .exec<{
        thread_id: number;
        from_address: string | null;
        participants: string;
      }>(
        `SELECT thread_id, from_address, participants FROM messages
         WHERE normalized_subject = ?
           AND normalized_subject <> ''
           AND thread_date BETWEEN ? AND ?
           AND (? = 1 OR is_orphan_reply = 1)
         ORDER BY thread_date DESC
         LIMIT ?`,
        normalized,
        date - SUBJECT_FALLBACK_WINDOW_MS,
        date + SUBJECT_FALLBACK_WINDOW_MS,
        isOrphan ? 1 : 0,
        MAX_SUBJECT_CANDIDATES,
      )
      .toArray()
      .filter((row) =>
        sameConversation(facts, {
          from: row.from_address?.toLowerCase() ?? null,
          participants: JSON.parse(row.participants) as string[],
        }),
      )
      .map((row) => row.thread_id);
  }

  #insertMessage(
    message: NewMessage,
    threadId: ThreadId,
    placement: Placement,
  ): MessageId {
    const { normalized, isReply } = normalizeSubject(message.subject);
    const [row] = this.#db
      .exec<{ id: number }>(
        `INSERT INTO messages (
           raw_hash, raw_size, r2_prefix, source, envelope_from, envelope_to,
           parse_status, rfc_message_id, refs, thread_id, from_name, from_address,
           reply_to, to_addresses, cc_addresses, participants, subject,
           normalized_subject, is_orphan_reply, snippet, sent_at, received_at,
           thread_date, is_read, is_starred, folder, has_attachments, auth_results
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        message.rawHash,
        message.rawSize,
        message.r2Prefix,
        message.source,
        message.envelopeFrom,
        message.envelopeTo,
        message.parseStatus,
        message.rfcMessageId,
        JSON.stringify(message.references),
        threadId,
        message.from?.name ?? null,
        message.from?.address ?? null,
        JSON.stringify(message.replyTo),
        JSON.stringify(message.to),
        JSON.stringify(message.cc),
        JSON.stringify(participantsOf(message)),
        message.subject,
        normalized,
        isReply && message.references.length === 0 ? 1 : 0,
        message.snippet,
        message.sentAt,
        message.receivedAt,
        message.sentAt ?? message.receivedAt,
        placement.read ? 1 : 0,
        placement.starred ? 1 : 0,
        placement.folder,
        message.attachments.some((attachment) => !attachment.inline) ? 1 : 0,
        message.authResults ? JSON.stringify(message.authResults) : null,
      )
      .toArray();
    const id = row!.id;

    for (const body of message.bodies) {
      this.#db.exec(
        "INSERT INTO message_bodies (message_id, kind, inline_content, r2_key, size) VALUES (?, ?, ?, ?, ?)",
        id,
        body.kind,
        "inline" in body ? body.inline : null,
        "r2Key" in body ? body.r2Key : null,
        body.size,
      );
    }
    for (const attachment of message.attachments) {
      this.#db.exec(
        `INSERT INTO attachments
           (message_id, position, filename, mime_type, is_inline, content_id, size, r2_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        attachment.position,
        attachment.filename,
        attachment.mimeType,
        attachment.inline ? 1 : 0,
        attachment.contentId,
        attachment.size,
        attachment.r2Key,
      );
    }
    const people = (list: Address[]) =>
      list.map((person) => `${person.name} ${person.address}`).join(" ");
    this.#db.exec(
      "INSERT INTO message_search (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)",
      id,
      message.subject ?? "",
      message.from ? people([message.from]) : "",
      people([...message.to, ...message.cc]),
      message.searchBody,
    );
    return id as MessageId;
  }

  // Rebuilds one thread's rows in the read model. Every change to a message's
  // folder, flags, labels, or thread must call this in the same transaction.
  refreshThread(threadId: ThreadId): void {
    const rows = this.#db
      .exec<ViewSourceRow>(
        `SELECT id, folder, subject, snippet, from_name, from_address,
                received_at, is_read, is_starred, has_attachments
         FROM messages WHERE thread_id = ? ORDER BY thread_date, id`,
        threadId,
      )
      .toArray();
    this.#db.exec("DELETE FROM thread_views WHERE thread_id = ?", threadId);
    if (rows.length === 0) {
      this.#db.exec("DELETE FROM threads WHERE id = ?", threadId);
      return;
    }

    const labelRows = this.#db
      .exec<{ message_id: number; label_id: number }>(
        `SELECT ml.message_id, ml.label_id FROM message_labels ml
         JOIN messages m ON m.id = ml.message_id WHERE m.thread_id = ?`,
        threadId,
      )
      .toArray();
    const labelsByMessage = Map.groupBy(labelRows, (row) => row.message_id);
    const views = new Map<ViewKey, ViewSourceRow[]>();
    const addTo = (view: ViewKey, row: ViewSourceRow) => {
      const members = views.get(view);
      if (members) members.push(row);
      else views.set(view, [row]);
    };
    for (const row of rows) {
      addTo(viewKey({ folder: row.folder }), row);
      // Spam and Trash are where mail goes to be out of the way, so a label only
      // shows and counts what is still live.
      if (row.folder === "spam" || row.folder === "trash") continue;
      for (const label of labelsByMessage.get(row.id) ?? []) {
        addTo(viewKey({ labelId: label.label_id as LabelId }), row);
      }
    }

    for (const [view, members] of views) {
      const row = describeMembers(members);
      this.#db.exec(
        `INSERT INTO thread_views (
           view, thread_id, last_at, subject, snippet, senders, message_count,
           unread_count, is_starred, has_attachments
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        view,
        threadId,
        row.lastMessageAt,
        row.subject,
        row.snippet,
        JSON.stringify(row.senders),
        row.messageCount,
        row.unreadCount,
        row.starred ? 1 : 0,
        row.hasAttachments ? 1 : 0,
      );
    }
  }

  listThreads(query: ThreadQuery): ThreadPage {
    const limit = Math.min(
      Math.max(1, Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE)),
      MAX_PAGE_SIZE,
    );
    const cursor = parseCursor(query.cursor);
    const rows = this.#db
      .exec<ViewRow>(
        `SELECT thread_id, last_at, subject, snippet, senders, message_count,
                unread_count, is_starred, has_attachments
         FROM thread_views
         WHERE view = ? AND (? IS NULL OR (last_at, thread_id) < (?, ?))
         ORDER BY last_at DESC, thread_id DESC
         LIMIT ?`,
        viewKey(query.view),
        cursor ? 1 : null,
        cursor?.lastAt ?? null,
        cursor?.threadId ?? null,
        limit + 1,
      )
      .toArray();
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const facts = this.threadFacts(page.map((row) => row.thread_id));
    return {
      threads: page.map((row) => toSummary(row, facts.get(row.thread_id))),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.last_at, last.thread_id)
          : null,
    };
  }

  // Read per page, not kept in the read model, so renaming or deleting a label
  // never has to touch the rows of every thread it is on. One trashed reply does
  // not make a live conversation count as trash, so its row offers moves that fit
  // the rest of it.
  threadFacts(threadIds: number[]): Map<number, ThreadFacts> {
    const rows = this.#db
      .exec<{ thread_id: number; folder: Folder; label_id: number | null }>(
        `SELECT DISTINCT m.thread_id, m.folder, ml.label_id
         FROM messages m LEFT JOIN message_labels ml ON ml.message_id = m.id
         WHERE m.thread_id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(threadIds),
      )
      .toArray();
    return new Map(
      [...Map.groupBy(rows, (row) => row.thread_id)].map(
        ([threadId, group]) => [
          threadId,
          {
            folders: liveFolders(group.map((row) => row.folder)),
            labelIds: [
              ...new Set(
                group.flatMap((row) =>
                  row.label_id === null ? [] : [row.label_id as LabelId],
                ),
              ),
            ],
          },
        ],
      ),
    );
  }

  getThread(threadId: ThreadId): ThreadDetail | null {
    const rows = this.#db
      .exec<MessageRow>(
        "SELECT * FROM messages WHERE thread_id = ? ORDER BY thread_date, id",
        threadId,
      )
      .toArray();
    if (rows.length === 0) return null;

    const attachments = this.#db
      .exec<AttachmentRow>(
        `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
         WHERE m.thread_id = ? ORDER BY a.message_id, a.position`,
        threadId,
      )
      .toArray();
    const labels = this.#db
      .exec<{ message_id: number; label_id: number }>(
        `SELECT ml.message_id, ml.label_id FROM message_labels ml
         JOIN messages m ON m.id = ml.message_id WHERE m.thread_id = ?`,
        threadId,
      )
      .toArray();
    const labelsByMessage = Map.groupBy(labels, (row) => row.message_id);
    const attachmentsByMessage = Map.groupBy(
      attachments,
      (row) => row.message_id,
    );
    return {
      id: threadId,
      messages: rows.map((row) =>
        toMessageDetail(
          row,
          (labelsByMessage.get(row.id) ?? []).map(
            (label) => label.label_id as LabelId,
          ),
          (attachmentsByMessage.get(row.id) ?? []).map(toAttachmentInfo),
        ),
      ),
    };
  }

  #select(selection: MessageSelection): RefRow[] {
    if ("messageIds" in selection) {
      return this.#db
        .exec<RefRow>(
          "SELECT id, thread_id, folder FROM messages WHERE id IN (SELECT value FROM json_each(?))",
          JSON.stringify(selection.messageIds),
        )
        .toArray();
    }
    return this.#db
      .exec<RefRow>(
        `SELECT id, thread_id, folder FROM messages
         WHERE thread_id IN (SELECT value FROM json_each(?))
           AND (?2 IS NULL OR folder IN (SELECT value FROM json_each(?2)))`,
        JSON.stringify(selection.threadIds),
        selection.inFolder === undefined
          ? null
          : JSON.stringify([selection.inFolder].flat()),
      )
      .toArray();
  }

  #refreshThreadsOf(rows: RefRow[]): void {
    for (const threadId of new Set(rows.map((row) => row.thread_id))) {
      this.refreshThread(threadId as ThreadId);
    }
  }

  setFlags(selection: MessageSelection, flags: MessageFlags): number {
    return this.#db.transaction(() => {
      const rows = this.#select(selection);
      this.#db.exec(
        `UPDATE messages
         SET is_read = COALESCE(?, is_read), is_starred = COALESCE(?, is_starred)
         WHERE id IN (SELECT value FROM json_each(?))`,
        flags.read === undefined ? null : flags.read ? 1 : 0,
        flags.starred === undefined ? null : flags.starred ? 1 : 0,
        JSON.stringify(rows.map((row) => row.id)),
      );
      this.#refreshThreadsOf(rows);
      return rows.length;
    });
  }

  // False when the label is gone, which a person with an old page open can reach.
  setLabel(
    selection: MessageSelection,
    labelId: LabelId,
    applied: boolean,
  ): boolean {
    return this.#db.transaction(() => {
      const [label] = this.#db
        .exec<{ id: number }>("SELECT id FROM labels WHERE id = ?", labelId)
        .toArray();
      if (!label) return false;
      const rows = this.#select(selection);
      const idsJson = JSON.stringify(rows.map((row) => row.id));
      this.#db.exec(
        applied
          ? `INSERT OR IGNORE INTO message_labels (message_id, label_id)
             SELECT value, ?1 FROM json_each(?2)`
          : `DELETE FROM message_labels
             WHERE label_id = ?1 AND message_id IN (SELECT value FROM json_each(?2))`,
        labelId,
        idsJson,
      );
      this.#refreshThreadsOf(rows);
      return true;
    });
  }

  // Returns where each message was, so an undo can put back exactly those messages
  // and not an older message of the thread that was already in the target folder.
  moveToFolder(selection: MessageSelection, folder: Folder): MessageRef[] {
    return this.#db.transaction(() => {
      const rows = this.#select(selection);
      this.#db.exec(
        "UPDATE messages SET folder = ? WHERE id IN (SELECT value FROM json_each(?))",
        folder,
        JSON.stringify(rows.map((row) => row.id)),
      );
      this.#refreshThreadsOf(rows);
      return rows.map(toRef);
    });
  }

  // Sends each message back to where mail of its kind lands, so restoring a thread
  // from Trash does not put the mailbox's own sent replies in the Inbox.
  restore(selection: MessageSelection): MessageRef[] {
    return this.#db.transaction(() => {
      const rows = this.#select(selection);
      this.#db.exec(
        `UPDATE messages
         SET folder = CASE source WHEN 'sent' THEN 'sent' WHEN 'import' THEN 'archive' ELSE 'inbox' END
         WHERE id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(rows.map((row) => row.id)),
      );
      this.#refreshThreadsOf(rows);
      return rows.map(toRef);
    });
  }

  threadOfMessage(messageId: MessageId): ThreadId | null {
    const [row] = this.#db
      .exec<{ thread_id: number }>(
        "SELECT thread_id FROM messages WHERE id = ?",
        messageId,
      )
      .toArray();
    return row ? (row.thread_id as ThreadId) : null;
  }

  summary(): MailboxSummary {
    const unread = new Map(
      this.#db
        .exec<{ view: ViewKey; unread: number }>(
          "SELECT view, COUNT(*) AS unread FROM thread_views WHERE unread_count > 0 GROUP BY view",
        )
        .toArray()
        .map((row) => [row.view, row.unread]),
    );
    const unreadIn = (view: ThreadView) => unread.get(viewKey(view)) ?? 0;
    return {
      folderUnread: Object.fromEntries(
        FOLDERS.map((folder) => [folder, unreadIn({ folder })]),
      ) as Record<Folder, number>,
      labels: this.#db
        .exec<{ id: number; name: string; colour: string }>(
          "SELECT id, name, colour FROM labels ORDER BY name COLLATE NOCASE",
        )
        .toArray()
        .map((row) => ({
          id: row.id as LabelId,
          name: row.name,
          colour: parseColour(row.colour),
          unread: unreadIn({ labelId: row.id as LabelId }),
        })),
    };
  }

  // Only trash and spam can be deleted for good, so a wrong id elsewhere cannot
  // destroy mail. Repeating a call finds nothing left and changes nothing.
  deleteForever(selection: MessageSelection): number {
    return this.#db.transaction(() => {
      const rows = this.#select(selection).filter(
        (row) => row.folder === "trash" || row.folder === "spam",
      );
      const idsJson = JSON.stringify(rows.map((row) => row.id));
      this.#db.exec(
        `INSERT OR IGNORE INTO r2_deletions (prefix, queued_at)
         SELECT r2_prefix, ? FROM messages WHERE id IN (SELECT value FROM json_each(?))`,
        Date.now(),
        idsJson,
      );
      this.#db.exec(
        "DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?))",
        idsJson,
      );
      this.#refreshThreadsOf(rows);
      return rows.length;
    });
  }

  // A prefix in this queue is never written or referenced again, so the sweep can
  // take its time: nothing that arrives later can share these objects. The delay
  // outlasts any write still in flight from an abandoned upload.
  queueDeletion(prefix: string, delayMs = DELETION_SETTLE_MS): void {
    const now = Date.now();
    this.#db.exec(
      "INSERT OR IGNORE INTO r2_deletions (prefix, queued_at, not_before) VALUES (?, ?, ?)",
      prefix,
      now,
      now + delayMs,
    );
  }

  pendingDeletions(limit: number, dueBy = Number.MAX_SAFE_INTEGER): string[] {
    return this.#db
      .exec<{ prefix: string }>(
        "SELECT prefix FROM r2_deletions WHERE not_before <= ? ORDER BY queued_at LIMIT ?",
        dueBy,
        limit,
      )
      .toArray()
      .map((row) => row.prefix);
  }

  postponeDeletions(dueBy: number, until: number): void {
    this.#db.exec(
      "UPDATE r2_deletions SET not_before = ? WHERE not_before <= ?",
      until,
      dueBy,
    );
  }

  nextDeletionAt(): number | null {
    const [row] = this.#db
      .exec<{ next: number | null }>(
        "SELECT MIN(not_before) AS next FROM r2_deletions",
      )
      .toArray();
    return row?.next ?? null;
  }

  finishDeletion(prefix: string): void {
    this.#db.exec("DELETE FROM r2_deletions WHERE prefix = ?", prefix);
  }

  bodyRefs(messageId: MessageId): BodyRef[] {
    return this.#db
      .exec<{
        kind: BodyKind;
        inline_content: string | null;
        r2_key: string | null;
      }>(
        "SELECT kind, inline_content, r2_key FROM message_bodies WHERE message_id = ?",
        messageId,
      )
      .toArray()
      .map((row) =>
        row.r2_key === null
          ? { kind: row.kind, inline: row.inline_content ?? "" }
          : { kind: row.kind, r2Key: row.r2_key },
      );
  }

  attachmentRef(
    messageId: MessageId,
    attachmentId: AttachmentId,
  ): AttachmentRef | null {
    const [row] = this.#db
      .exec<AttachmentRow>(
        "SELECT * FROM attachments WHERE id = ? AND message_id = ?",
        attachmentId,
        messageId,
      )
      .toArray();
    return row ? { ...toAttachmentInfo(row), r2Key: row.r2_key } : null;
  }

  inlineAttachmentRefs(messageId: MessageId): AttachmentRef[] {
    return this.#db
      .exec<AttachmentRow>(
        `SELECT * FROM attachments
         WHERE message_id = ? AND is_inline = 1 AND content_id IS NOT NULL
         ORDER BY position`,
        messageId,
      )
      .toArray()
      .map((row) => ({ ...toAttachmentInfo(row), r2Key: row.r2_key }));
  }

  storagePrefix(messageId: MessageId): string | null {
    const [row] = this.#db
      .exec<{ r2_prefix: string }>(
        "SELECT r2_prefix FROM messages WHERE id = ?",
        messageId,
      )
      .toArray();
    return row?.r2_prefix ?? null;
  }
}

const DELETIONS_PER_SWEEP = 50;
const R2_DELETE_BATCH = 1000;

// Repeatable: a prefix leaves the queue only after its objects are gone, and
// listing a prefix that is already empty finds nothing to do.
export async function sweepDeletions(
  store: MailboxStore,
  bucket: Pick<R2Bucket, "list" | "delete">,
  now = Date.now(),
): Promise<boolean> {
  for (const prefix of store.pendingDeletions(DELETIONS_PER_SWEEP, now)) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({
        prefix,
        cursor,
        limit: R2_DELETE_BATCH,
      });
      if (page.objects.length > 0) {
        await bucket.delete(page.objects.map((object) => object.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    store.finishDeletion(prefix);
  }
  return store.pendingDeletions(1, now).length > 0;
}
