import type { MailboxId } from "@cloudysuite/access";
import type { SqlDriver, SqlRow } from "../sql";
import type { MailboxStore } from "../store";
import type {
  Address,
  CommitResult,
  MessageId,
  NewMessage,
  ThreadId,
} from "../types";
import type {
  ComposeMode,
  DraftContent,
  Editor,
  OutgoingAttachment,
  OutgoingDetail,
  OutgoingId,
  OutgoingState,
  OutgoingSummary,
  ParentFacts,
  SaveResult,
  SendFailure,
} from "./types";
import {
  fitsSendLimit,
  MAX_ATTACHMENTS,
  TOO_LARGE_TEXT,
  TOO_MANY_ATTACHMENTS_TEXT,
  UNDO_WINDOW_MS,
} from "./types";

// A claim that never finished is found by this wake-up, and only then, since one
// mailbox's alarm handlers never overlap.
const SENDING_CHECK_MS = 60_000;
const FINISHED_KEPT_MS = 24 * 60 * 60 * 1000;
const SENT_NOTE_KEPT_MS = 60 * 60 * 1000;
const SNIPPET_LENGTH = 140;

type OutgoingFields = {
  id: string;
  state: OutgoingState;
  revision: number;
  mode: ComposeMode;
  parent_message_id: number | null;
  parent_rfc_id: string | null;
  parent_refs: string;
  from_address: string;
  from_name: string;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
  subject: string;
  html: string;
  body_text: string;
  include_quote: number;
  quote_bytes: number | null;
  quote_designed: number;
  r2_prefix: string;
  updated_by: string;
  updated_by_name: string;
  updated_at: number;
  sent_by: string | null;
  mailbox_id: string | null;
  due_at: number | null;
  attempts: number;
  failure: SendFailure | null;
  returned_message_id: string | null;
  accepted_at: number | null;
  stored_message_id: number | null;
  thread_id: number | null;
  attachment_count: number;
};

type OutgoingRow = SqlRow & OutgoingFields;

type AttachmentRow = SqlRow & {
  id: number;
  filename: string;
  mime_type: string;
  size: number;
  r2_key: string;
};

const SELECT_ROW = `
  SELECT o.*,
    COALESCE(
      (SELECT thread_id FROM messages WHERE id = o.stored_message_id),
      (SELECT thread_id FROM messages WHERE id = o.parent_message_id)
    ) AS thread_id,
    (SELECT COUNT(*) FROM outgoing_attachments a WHERE a.outgoing_id = o.id) AS attachment_count
  FROM outgoing o`;

const addressesIn = (json: string) => JSON.parse(json) as Address[];

const toAttachment = (row: AttachmentRow): OutgoingAttachment => ({
  id: row.id,
  filename: row.filename,
  mimeType: row.mime_type,
  size: row.size,
});

function toSummary(
  row: OutgoingRow,
  viewerId: string,
  now: number,
): OutgoingSummary {
  return {
    id: row.id as OutgoingId,
    state: row.state,
    mode: row.mode,
    to: addressesIn(row.to_addresses),
    subject: row.subject,
    snippet: row.body_text.slice(0, SNIPPET_LENGTH),
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
    attachmentCount: row.attachment_count,
    threadId: row.thread_id === null ? null : (row.thread_id as ThreadId),
    failure: row.failure,
    msUntilDue:
      row.state === "scheduled" && row.due_at !== null
        ? Math.max(0, row.due_at - now)
        : null,
    retrying: row.state === "scheduled" && row.attempts > 0,
    sentByViewer: row.sent_by === viewerId,
  };
}

export type NewOutgoing = {
  id: OutgoingId;
  mode: ComposeMode;
  parent: ParentFacts | null;
  content: DraftContent;
  r2Prefix: string;
  quote: { bytes: number; designed: boolean } | null;
  attachments: {
    filename: string;
    mimeType: string;
    size: number;
    r2Key: string;
  }[];
  editor: Editor;
};

export type DueJob = OutgoingFields & { files: AttachmentRow[] };

export type ScheduleResult =
  { status: "scheduled" } | { status: "locked"; state: OutgoingState };

export type AddAttachmentResult =
  | { status: "added"; attachment: OutgoingAttachment }
  | { status: "refused"; httpStatus: number; message: string };

// Every read and write of the send job's table. See types.ts for its state machine.
export class OutgoingStore {
  readonly #db: SqlDriver;
  readonly #mail: MailboxStore;

  constructor(db: SqlDriver, mail: MailboxStore) {
    this.#db = db;
    this.#mail = mail;
  }

  #row(id: OutgoingId): OutgoingRow | null {
    const [row] = this.#db
      .exec<OutgoingRow>(`${SELECT_ROW} WHERE o.id = ?`, id)
      .toArray();
    return row ?? null;
  }

  #attachments(id: OutgoingId): AttachmentRow[] {
    return this.#db
      .exec<AttachmentRow>(
        "SELECT id, filename, mime_type, size, r2_key FROM outgoing_attachments WHERE outgoing_id = ? ORDER BY id",
        id,
      )
      .toArray();
  }

  detail(
    id: OutgoingId,
    viewerId: string,
    now = Date.now(),
  ): OutgoingDetail | null {
    const row = this.#row(id);
    if (!row) return null;
    return {
      ...toSummary(row, viewerId, now),
      revision: row.revision,
      parent:
        row.parent_message_id === null
          ? null
          : {
              messageId: row.parent_message_id as MessageId,
              rfcMessageId: row.parent_rfc_id,
              references: JSON.parse(row.parent_refs) as string[],
            },
      content: {
        from: row.from_address,
        to: addressesIn(row.to_addresses),
        cc: addressesIn(row.cc_addresses),
        bcc: addressesIn(row.bcc_addresses),
        subject: row.subject,
        html: row.html,
        includeQuote: row.include_quote === 1,
      },
      attachments: this.#attachments(id).map(toAttachment),
      quote:
        row.quote_bytes === null
          ? null
          : { bytes: row.quote_bytes, designed: row.quote_designed === 1 },
    };
  }

  // Everything still open, newest first, plus what went out just now, so the screen
  // that pressed Send can see it go through.
  list(viewerId: string, now = Date.now()): OutgoingSummary[] {
    return this.#db
      .exec<OutgoingRow>(
        `${SELECT_ROW} WHERE o.state <> 'sent' OR o.updated_at > ? ORDER BY o.updated_at DESC LIMIT 200`,
        now - SENT_NOTE_KEPT_MS,
      )
      .toArray()
      .map((row) => toSummary(row, viewerId, now));
  }

  // Safe to repeat: the id comes from the browser, so a retried request finds its row.
  create(input: NewOutgoing, now = Date.now()): void {
    this.#db.transaction(() => {
      const { rowsWritten } = this.#insert(input, now);
      if (rowsWritten === 0) return;
      for (const attachment of input.attachments) {
        this.#db.exec(
          "INSERT INTO outgoing_attachments (outgoing_id, filename, mime_type, size, r2_key) VALUES (?, ?, ?, ?, ?)",
          input.id,
          attachment.filename,
          attachment.mimeType,
          attachment.size,
          attachment.r2Key,
        );
      }
    });
  }

  #insert(input: NewOutgoing, now: number): { rowsWritten: number } {
    const inserted = this.#db
      .exec<{ id: string }>(
        `INSERT OR IGNORE INTO outgoing (
           id, state, revision, mode, parent_message_id, parent_rfc_id, parent_refs,
           from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
           subject, html, body_text, include_quote, quote_bytes, quote_designed,
           r2_prefix, updated_by, updated_by_name, updated_at
         ) VALUES (?, 'draft', 1, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        input.id,
        input.mode,
        input.parent?.messageId ?? null,
        input.parent?.rfcMessageId ?? null,
        JSON.stringify(input.parent?.references ?? []),
        input.content.from,
        JSON.stringify(input.content.to),
        JSON.stringify(input.content.cc),
        JSON.stringify(input.content.bcc),
        input.content.subject,
        input.content.html,
        "",
        input.content.includeQuote ? 1 : 0,
        input.quote?.bytes ?? null,
        input.quote?.designed ? 1 : 0,
        input.r2Prefix,
        input.editor.id,
        input.editor.name,
        now,
      )
      .toArray();
    return { rowsWritten: inserted.length };
  }

  #writeContent(
    id: OutgoingId,
    content: DraftContent,
    plainText: string,
    editor: Editor,
    now: number,
  ): number {
    const [row] = this.#db
      .exec<{ revision: number }>(
        `UPDATE outgoing SET
           revision = revision + 1, from_address = ?, to_addresses = ?, cc_addresses = ?,
           bcc_addresses = ?, subject = ?, html = ?, body_text = ?, include_quote = ?,
           updated_by = ?, updated_by_name = ?, updated_at = ?
         WHERE id = ? RETURNING revision`,
        content.from,
        JSON.stringify(content.to),
        JSON.stringify(content.cc),
        JSON.stringify(content.bcc),
        content.subject,
        content.html,
        plainText,
        content.includeQuote ? 1 : 0,
        editor.id,
        editor.name,
        now,
        id,
      )
      .toArray();
    return row!.revision;
  }

  // Each save is an update to one row, so autosave cannot pile up messages. Two people
  // on one draft: the last save wins, and the later one is told whose work it replaced.
  save(
    input: {
      id: OutgoingId;
      baseRevision: number;
      content: DraftContent;
      plainText: string;
      editor: Editor;
      r2Prefix: string;
    },
    now = Date.now(),
  ): SaveResult {
    return this.#db.transaction(() => {
      const { id, baseRevision, content, plainText, editor, r2Prefix } = input;
      const row = this.#row(id);
      if (!row) {
        this.#insert(
          {
            id,
            mode: "new",
            parent: null,
            content,
            r2Prefix,
            quote: null,
            attachments: [],
            editor,
          },
          now,
        );
        return {
          status: "saved",
          revision: this.#writeContent(id, content, plainText, editor, now),
          overwrote: null,
        };
      }
      if (row.state !== "draft") return { status: "locked", state: row.state };
      const overwrote =
        row.revision !== baseRevision && row.updated_by !== editor.id
          ? row.updated_by_name
          : null;
      return {
        status: "saved",
        revision: this.#writeContent(id, content, plainText, editor, now),
        overwrote,
      };
    });
  }

  // Pressing Send twice, or a retried request, finds it already scheduled and leaves
  // the undo window where it was.
  schedule(
    input: {
      id: OutgoingId;
      content: DraftContent;
      plainText: string;
      editor: Editor;
      r2Prefix: string;
      fromName: string;
      mailboxId: MailboxId;
    },
    now = Date.now(),
  ): ScheduleResult {
    return this.#db.transaction(() => {
      const { id, content, plainText, editor, r2Prefix, fromName, mailboxId } =
        input;
      const row = this.#row(id);
      if (row?.state === "scheduled") return { status: "scheduled" };
      if (row && row.state !== "draft") {
        return { status: "locked", state: row.state };
      }
      if (!row) {
        this.#insert(
          {
            id,
            mode: "new",
            parent: null,
            content,
            r2Prefix,
            quote: null,
            attachments: [],
            editor,
          },
          now,
        );
      }
      this.#writeContent(id, content, plainText, editor, now);
      this.#db.exec(
        `UPDATE outgoing SET
           state = 'scheduled', due_at = ?, attempts = 0, failure = NULL,
           from_name = ?, sent_by = ?, mailbox_id = ?
         WHERE id = ?`,
        now + UNDO_WINDOW_MS,
        fromName,
        editor.id,
        mailboxId,
        id,
      );
      this.#purgeFinished(now);
      return { status: "scheduled" };
    });
  }

  #purgeFinished(now: number): void {
    this.#db.exec(
      "DELETE FROM outgoing WHERE state = 'sent' AND updated_at < ?",
      now - FINISHED_KEPT_MS,
    );
  }

  // False when the window has closed, whichever side reached the row first.
  undo(id: OutgoingId): boolean {
    return (
      this.#db
        .exec(
          "UPDATE outgoing SET state = 'draft', due_at = NULL, attempts = 0 WHERE id = ? AND state = 'scheduled' RETURNING id",
          id,
        )
        .toArray().length > 0
    );
  }

  // Sending again after `unknown` is the person's own decision, with the warning shown.
  reopen(id: OutgoingId): boolean {
    return (
      this.#db
        .exec(
          "UPDATE outgoing SET state = 'draft', due_at = NULL, attempts = 0, failure = NULL WHERE id = ? AND state IN ('failed', 'unknown') RETURNING id",
          id,
        )
        .toArray().length > 0
    );
  }

  // Drafts never become rows in `messages`, so a discarded one has no Trash or restore
  // path to get wrong: its row goes now, and its files follow through the queue.
  discard(id: OutgoingId): boolean {
    return this.#db.transaction(() => {
      const row = this.#row(id);
      if (!row || !["draft", "failed", "unknown"].includes(row.state)) {
        return false;
      }
      this.#db.exec("DELETE FROM outgoing WHERE id = ?", id);
      this.#mail.queueDeletion(row.r2_prefix);
      return true;
    });
  }

  // Checks the limits again in the transaction, because two uploads can pass the
  // earlier check at once. The caller removes the file if this refuses it.
  addAttachment(
    input: {
      id: OutgoingId;
      filename: string;
      mimeType: string;
      size: number;
      r2Key: string;
      editor: Editor;
      r2Prefix: string;
      fromAddress: string;
    },
    now = Date.now(),
  ): AddAttachmentResult {
    return this.#db.transaction(() => {
      const { id, filename, mimeType, size, r2Key, editor } = input;
      let row = this.#row(id);
      if (!row) {
        this.#insert(
          {
            id,
            mode: "new",
            parent: null,
            content: {
              from: input.fromAddress,
              to: [],
              cc: [],
              bcc: [],
              subject: "",
              html: "",
              includeQuote: false,
            },
            r2Prefix: input.r2Prefix,
            quote: null,
            attachments: [],
            editor,
          },
          now,
        );
        row = this.#row(id)!;
      }
      if (row.state !== "draft") {
        return {
          status: "refused",
          httpStatus: 409,
          message:
            "This message is already on its way, so it can't take more files.",
        };
      }
      const existing = this.#attachments(id);
      if (existing.length >= MAX_ATTACHMENTS) {
        return {
          status: "refused",
          httpStatus: 400,
          message: TOO_MANY_ATTACHMENTS_TEXT,
        };
      }
      const fits = fitsSendLimit({
        bodyBytes: new TextEncoder().encode(row.html).byteLength,
        quoteBytes: row.quote_bytes ?? 0,
        attachmentSizes: [...existing.map((file) => file.size), size],
      });
      if (!fits) {
        return { status: "refused", httpStatus: 413, message: TOO_LARGE_TEXT };
      }
      const [added] = this.#db
        .exec<AttachmentRow>(
          `INSERT INTO outgoing_attachments (outgoing_id, filename, mime_type, size, r2_key)
           VALUES (?, ?, ?, ?, ?)
           RETURNING id, filename, mime_type, size, r2_key`,
          id,
          filename,
          mimeType,
          size,
          r2Key,
        )
        .toArray();
      this.#db.exec("UPDATE outgoing SET updated_at = ? WHERE id = ?", now, id);
      return { status: "added", attachment: toAttachment(added!) };
    });
  }

  // True when the file is gone or was never here. False while the message is on its
  // way, because the send still needs it.
  removeAttachment(id: OutgoingId, attachmentId: number): boolean {
    return this.#db.transaction(() => {
      const row = this.#row(id);
      if (!row) return true;
      if (row.state !== "draft") return false;
      const [removed] = this.#db
        .exec<{ r2_key: string }>(
          "DELETE FROM outgoing_attachments WHERE id = ? AND outgoing_id = ? RETURNING r2_key",
          attachmentId,
          id,
        )
        .toArray();
      if (removed) this.#mail.queueDeletion(removed.r2_key);
      return true;
    });
  }

  attachmentSizes(id: OutgoingId): number[] {
    return this.#attachments(id).map((file) => file.size);
  }

  suggestions(query: string, limit: number): Address[] {
    const pattern = `${query.replace(/[\\%_]/g, "\\$&")}%`;
    return this.#db
      .exec<{ name: string; address: string }>(
        `SELECT name, address FROM correspondents
         WHERE address LIKE ?1 ESCAPE '\\' OR name LIKE ?1 ESCAPE '\\' OR name LIKE '% ' || ?1 ESCAPE '\\'
         ORDER BY last_at DESC LIMIT ?2`,
        pattern,
        limit,
      )
      .toArray()
      .map(({ name, address }) => ({ name, address }));
  }

  // --- The alarm's side of the state machine ---

  nextDueAt(): number | null {
    const [row] = this.#db
      .exec<{ next: number | null }>(
        "SELECT MIN(due_at) AS next FROM outgoing WHERE due_at IS NOT NULL",
      )
      .toArray();
    return row?.next ?? null;
  }

  dueJobs(now: number): DueJob[] {
    return this.#db
      .exec<OutgoingRow>(
        `${SELECT_ROW} WHERE o.due_at IS NOT NULL AND o.due_at <= ? ORDER BY o.due_at`,
        now,
      )
      .toArray()
      .map((row) => ({
        ...row,
        files: this.#attachments(row.id as OutgoingId),
      }));
  }

  // The record of intent. Once this is on disk, a crash can only ever lead to
  // `unknown`, never to a second send. False if Undo got there first. The job holds what
  // was read and checked, so a revision changed by an undo and a new Send doesn't count.
  claim(id: OutgoingId, revision: number, now: number): boolean {
    return (
      this.#db
        .exec(
          "UPDATE outgoing SET state = 'sending', due_at = ?, updated_at = ? WHERE id = ? AND state = 'scheduled' AND revision = ? RETURNING id",
          now + SENDING_CHECK_MS,
          now,
          id,
          revision,
        )
        .toArray().length > 0
    );
  }

  postpone(id: OutgoingId, attempts: number, dueAt: number): void {
    this.#db.exec(
      "UPDATE outgoing SET state = 'scheduled', attempts = ?, due_at = ? WHERE id = ? AND state IN ('scheduled', 'sending')",
      attempts,
      dueAt,
      id,
    );
  }

  fail(id: OutgoingId, failure: SendFailure, now: number): void {
    this.#db.exec(
      "UPDATE outgoing SET state = 'failed', failure = ?, due_at = NULL, updated_at = ? WHERE id = ? AND state IN ('scheduled', 'sending')",
      failure,
      now,
      id,
    );
  }

  markUnknown(id: OutgoingId, now: number): void {
    this.#db.exec(
      "UPDATE outgoing SET state = 'unknown', due_at = NULL, updated_at = ? WHERE id = ? AND state = 'sending'",
      now,
      id,
    );
  }

  accept(id: OutgoingId, returnedMessageId: string, now: number): void {
    this.#db.exec(
      `UPDATE outgoing SET
         state = 'accepted', returned_message_id = ?, accepted_at = ?, attempts = 0,
         due_at = ?, updated_at = ?
       WHERE id = ? AND state = 'sending'`,
      returnedMessageId,
      now,
      now,
      now,
      id,
    );
  }

  postponeStoring(id: OutgoingId, attempts: number, dueAt: number): void {
    this.#db.exec(
      "UPDATE outgoing SET attempts = ?, due_at = ? WHERE id = ? AND state = 'accepted'",
      attempts,
      dueAt,
      id,
    );
  }

  // The stored copy and the end of the job land together, so no crash can store it
  // twice. The draft's content and files go here too: a draft is deleted on send.
  finish(id: OutgoingId, copy: NewMessage, now: number): CommitResult {
    return this.#db.transaction(() => {
      const row = this.#row(id)!;
      const result = this.#mail.commit(copy);
      this.#db.exec(
        `UPDATE outgoing SET
           state = 'sent', html = '', body_text = '', bcc_addresses = '[]',
           cc_addresses = '[]', due_at = NULL, updated_at = ?, stored_message_id = ?
         WHERE id = ?`,
        now,
        result.messageId,
        id,
      );
      this.#db.exec(
        "DELETE FROM outgoing_attachments WHERE outgoing_id = ?",
        id,
      );
      this.#mail.queueDeletion(row.r2_prefix);
      return result;
    });
  }
}
