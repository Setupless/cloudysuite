import type { MailboxId } from "@cloudysuite/access";
import type { SqlDriver, SqlRow } from "@cloudysuite/object-sql";
import type { MailboxStore } from "../store";
import type {
  Address,
  AttachmentId,
  CommitResult,
  MessageId,
  NewMessage,
  ThreadId,
} from "../types";
import { copyHoldsSomething, holdsSomethingAdded } from "./added";
import type {
  ComposeMode,
  DraftContent,
  DraftHolds,
  DraftPrefill,
  Editor,
  KeptSaveResult,
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
  writtenBytes,
  MAX_ATTACHMENTS,
  NOTHING_PREFILLED,
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
  upload_count: number;
  prefill_to: string;
  prefill_cc: string;
  prefill_subject: string;
};

type OutgoingRow = SqlRow & OutgoingFields;

type AttachmentRow = SqlRow & {
  id: number;
  filename: string;
  mime_type: string;
  size: number;
  r2_key: string;
  carried_from: number | null;
};

const SELECT_ROW = `
  SELECT o.*,
    COALESCE(
      (SELECT thread_id FROM messages WHERE id = o.stored_message_id),
      (SELECT thread_id FROM messages WHERE id = o.parent_message_id)
    ) AS thread_id,
    (SELECT COUNT(*) FROM outgoing_attachments a WHERE a.outgoing_id = o.id) AS attachment_count,
    (SELECT COUNT(*) FROM outgoing_attachments a WHERE a.outgoing_id = o.id AND a.carried_from IS NULL) AS upload_count
  FROM outgoing o`;

const addressesIn = (json: string) => JSON.parse(json) as Address[];

// Words from a device can ask for a quote that only the row it was written on had.
const withQuoteOnlyIfHeld = (
  content: DraftContent,
  row: OutgoingRow | null,
  create?: NewOutgoing,
): DraftContent =>
  (row ? row.quote_bytes : create?.quote) == null
    ? { ...content, includeQuote: false }
    : content;

const holdsContent = (row: OutgoingRow, content: DraftContent): boolean =>
  row.from_address === content.from &&
  row.to_addresses === JSON.stringify(content.to) &&
  row.cc_addresses === JSON.stringify(content.cc) &&
  row.bcc_addresses === JSON.stringify(content.bcc) &&
  row.subject === content.subject &&
  row.html === content.html &&
  (row.include_quote === 1) === content.includeQuote;

const toAttachment = (row: AttachmentRow): OutgoingAttachment => ({
  id: row.id,
  filename: row.filename,
  mimeType: row.mime_type,
  size: row.size,
  carriedFrom: row.carried_from as AttachmentId | null,
});

const prefillOf = (row: OutgoingRow): DraftPrefill => ({
  to: addressesIn(row.prefill_to),
  cc: addressesIn(row.prefill_cc),
  subject: row.prefill_subject,
});

const holdsSomething = (row: OutgoingRow) =>
  holdsSomethingAdded(
    {
      content: {
        to: addressesIn(row.to_addresses),
        cc: addressesIn(row.cc_addresses),
        bcc: addressesIn(row.bcc_addresses),
        subject: row.subject,
        html: row.html,
      },
      uploads: row.upload_count,
    },
    prefillOf(row),
  );

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
  prefill: DraftPrefill;
  content: DraftContent;
  r2Prefix: string;
  quote: { bytes: number; designed: boolean } | null;
  attachments: {
    filename: string;
    mimeType: string;
    size: number;
    r2Key: string;
    carriedFrom: AttachmentId;
  }[];
  editor: Editor;
};

export type DueJob = OutgoingFields & { files: AttachmentRow[] };

export type ScheduleResult =
  { status: "scheduled" } | { status: "locked"; state: OutgoingState };

export type AddAttachmentResult =
  | {
      status: "added";
      attachment: OutgoingAttachment;
      revision: number;
      carried: OutgoingAttachment[];
    }
  | { status: "refused"; httpStatus: number; message: string };

const plainRow = (
  id: OutgoingId,
  content: DraftContent,
  r2Prefix: string,
  editor: Editor,
): NewOutgoing => ({
  id,
  mode: "new",
  parent: null,
  prefill: NOTHING_PREFILLED,
  content,
  r2Prefix,
  quote: null,
  attachments: [],
  editor,
});

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
        "SELECT id, filename, mime_type, size, r2_key, carried_from FROM outgoing_attachments WHERE outgoing_id = ? ORDER BY id",
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
      prefill: prefillOf(row),
    };
  }

  #carried(id: OutgoingId): OutgoingAttachment[] {
    return this.#attachments(id)
      .filter((file) => file.carried_from !== null)
      .map(toAttachment);
  }

  // Everything still open, newest first, plus what went out just now, so the screen
  // that pressed Send can see it go through. A draft holding nothing anyone added is
  // left out: earlier builds made them on opening a reply, and one can still be left by
  // a crash after someone removes the only file they had added.
  list(viewerId: string, now = Date.now()): OutgoingSummary[] {
    return this.#db
      .exec<OutgoingRow>(
        `${SELECT_ROW} WHERE o.state <> 'sent' OR o.updated_at > ? ORDER BY o.updated_at DESC LIMIT 200`,
        now - SENT_NOTE_KEPT_MS,
      )
      .toArray()
      .filter((row) => row.state !== "draft" || holdsSomething(row))
      .map((row) => toSummary(row, viewerId, now));
  }

  // Safe to repeat: the id comes from the browser, so a retried request finds its row.
  #create(input: NewOutgoing, now: number): void {
    const { rowsWritten } = this.#insert(input, now);
    if (rowsWritten === 0) return;
    for (const attachment of input.attachments) {
      this.#db.exec(
        "INSERT INTO outgoing_attachments (outgoing_id, filename, mime_type, size, r2_key, carried_from) VALUES (?, ?, ?, ?, ?, ?)",
        input.id,
        attachment.filename,
        attachment.mimeType,
        attachment.size,
        attachment.r2Key,
        attachment.carriedFrom,
      );
    }
  }

  #insert(input: NewOutgoing, now: number): { rowsWritten: number } {
    const inserted = this.#db
      .exec<{ id: string }>(
        `INSERT OR IGNORE INTO outgoing (
           id, state, revision, mode, parent_message_id, parent_rfc_id, parent_refs,
           from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
           subject, html, body_text, include_quote, quote_bytes, quote_designed,
           r2_prefix, updated_by, updated_by_name, updated_at,
           prefill_to, prefill_cc, prefill_subject
         ) VALUES (?, 'draft', 1, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        JSON.stringify(input.prefill.to),
        JSON.stringify(input.prefill.cc),
        input.prefill.subject,
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

  #writeNew(
    id: OutgoingId,
    content: DraftContent,
    plainText: string,
    editor: Editor,
    r2Prefix: string,
    now: number,
  ): number {
    this.#create(plainRow(id, content, r2Prefix, editor), now);
    return this.#writeContent(id, content, plainText, editor, now);
  }

  #holds(id: OutgoingId): DraftHolds {
    const row = this.#row(id)!;
    const files = this.#attachments(id);
    return {
      attachmentIds: files.map((file) => file.id),
      carriedFrom: files.flatMap((file) => file.carried_from ?? []),
      quote: row.quote_bytes !== null,
      threaded: row.parent_message_id !== null,
    };
  }

  // Each save is an update to one row, so autosave cannot pile up messages. Two people
  // on one draft: the last save wins, and the later one is told whose work it replaced.
  // Holding nothing anyone added writes nothing, so a row always keeps the last words it
  // had. It goes only when the person leaves, and not if someone has saved since they
  // last looked, because those are words this person hasn't seen.
  save(
    input: {
      id: OutgoingId;
      baseRevision: number;
      content: DraftContent;
      plainText: string;
      editor: Editor;
      r2Prefix: string;
      create?: NewOutgoing;
      leaving?: boolean;
    },
    now = Date.now(),
  ): SaveResult {
    return this.#db.transaction(() => {
      const { id, baseRevision, plainText, editor, r2Prefix, create } = input;
      const row = this.#row(id);
      const content = withQuoteOnlyIfHeld(input.content, row, create);
      if (row && row.state !== "draft") {
        return { status: "locked", state: row.state };
      }
      const holds = holdsSomethingAdded(
        { content, uploads: row?.upload_count ?? 0 },
        row ? prefillOf(row) : (create?.prefill ?? NOTHING_PREFILLED),
      );
      if (!holds) {
        if (!row || !input.leaving) return { status: "nothing" };
        if (row.revision !== baseRevision) return { status: "changed" };
        this.#remove(row);
        return { status: "removed" };
      }
      if (!row) {
        this.#create(create ?? plainRow(id, content, r2Prefix, editor), now);
      }
      const overwrote =
        row && row.revision !== baseRevision && row.updated_by !== editor.id
          ? row.updated_by_name
          : null;
      return {
        status: "saved",
        revision: this.#writeContent(id, content, plainText, editor, now),
        overwrote,
        holds: this.#holds(id),
        carried: this.#carried(id),
      };
    });
  }

  // Words coming back from a device can be hours behind, and nobody may be watching. They
  // replace the draft only if it is still what they were written on. Otherwise both sets
  // of words stay. The check and the write share this transaction, so no save can land
  // between them. Safe to repeat: `copyId` comes from the kept version, so a retry finds
  // the copy, and words already saved count as unchanged.
  saveKept(
    input: {
      id: OutgoingId;
      copyId: OutgoingId;
      baseRevision: number;
      content: DraftContent;
      plainText: string;
      editor: Editor;
      r2Prefix: string;
      copyR2Prefix: string;
      create?: NewOutgoing;
    },
    now = Date.now(),
  ): KeptSaveResult {
    return this.#db.transaction(() => {
      const { id, copyId, baseRevision, plainText, editor, create } = input;
      const row = this.#row(id);
      const content = withQuoteOnlyIfHeld(input.content, row, create);
      const changed =
        row?.state === "draft" && row.revision !== baseRevision
          ? { by: row.updated_by === editor.id ? null : row.updated_by_name }
          : null;
      const copy = this.#row(copyId);
      if (copy) {
        return {
          status: "copied",
          copyId,
          copyIsDraft: copy.state === "draft",
          changed,
        };
      }
      const prefill = row
        ? prefillOf(row)
        : (create?.prefill ?? NOTHING_PREFILLED);
      const uploads = row?.upload_count ?? 0;
      if (!holdsSomethingAdded({ content, uploads }, prefill)) {
        return { status: "nothing" };
      }
      if (!row) {
        this.#create(
          create ?? plainRow(id, content, input.r2Prefix, editor),
          now,
        );
        return {
          status: "saved",
          revision: this.#writeContent(id, content, plainText, editor, now),
          holds: this.#holds(id),
        };
      }
      if (row.state === "draft" && (!changed || holdsContent(row, content))) {
        return {
          status: "saved",
          revision: changed
            ? row.revision
            : this.#writeContent(id, content, plainText, editor, now),
          holds: this.#holds(id),
        };
      }
      if (!copyHoldsSomething(content, prefill)) return { status: "nothing" };
      this.#writeNew(
        copyId,
        withQuoteOnlyIfHeld(input.content, null),
        plainText,
        editor,
        input.copyR2Prefix,
        now,
      );
      return { status: "copied", copyId, copyIsDraft: true, changed };
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
      create?: NewOutgoing;
    },
    now = Date.now(),
  ): ScheduleResult {
    return this.#db.transaction(() => {
      const { id, plainText, editor, r2Prefix, fromName, mailboxId } = input;
      const row = this.#row(id);
      const content = withQuoteOnlyIfHeld(input.content, row, input.create);
      if (row?.state === "scheduled") return { status: "scheduled" };
      if (row && row.state !== "draft") {
        return { status: "locked", state: row.state };
      }
      if (!row) {
        this.#create(
          input.create ?? plainRow(id, content, r2Prefix, editor),
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
      this.#remove(row);
      return true;
    });
  }

  #remove(row: OutgoingRow): void {
    this.#db.exec("DELETE FROM outgoing WHERE id = ?", row.id);
    this.#mail.queueDeletion(row.r2_prefix);
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
      create?: NewOutgoing;
    },
    now = Date.now(),
  ): AddAttachmentResult {
    return this.#db.transaction(() => {
      const { id, filename, mimeType, size, r2Key, editor, create } = input;
      const row = this.#row(id);
      if (row && row.state !== "draft") {
        return {
          status: "refused",
          httpStatus: 409,
          message:
            "This message is already on its way, so it can't take more files.",
        };
      }
      const existing = row
        ? this.#attachments(id)
        : (create?.attachments ?? []);
      if (existing.length >= MAX_ATTACHMENTS) {
        return {
          status: "refused",
          httpStatus: 400,
          message: TOO_MANY_ATTACHMENTS_TEXT,
        };
      }
      const quoteBytes = row
        ? row.include_quote === 1
          ? (row.quote_bytes ?? 0)
          : 0
        : create?.content.includeQuote
          ? (create.quote?.bytes ?? 0)
          : 0;
      const fits = fitsSendLimit({
        bodyBytes: row ? writtenBytes(row.html, row.body_text) : 0,
        quoteBytes,
        attachmentSizes: [...existing.map((file) => file.size), size],
      });
      if (!fits) {
        return { status: "refused", httpStatus: 413, message: TOO_LARGE_TEXT };
      }
      if (!row) {
        const empty: DraftContent = {
          from: input.fromAddress,
          to: [],
          cc: [],
          bcc: [],
          subject: "",
          html: "",
          includeQuote: false,
        };
        this.#create(
          create ?? plainRow(id, empty, input.r2Prefix, editor),
          now,
        );
      }
      const [added] = this.#db
        .exec<AttachmentRow>(
          `INSERT INTO outgoing_attachments (outgoing_id, filename, mime_type, size, r2_key)
           VALUES (?, ?, ?, ?, ?)
           RETURNING id, filename, mime_type, size, r2_key, carried_from`,
          id,
          filename,
          mimeType,
          size,
          r2Key,
        )
        .toArray();
      this.#db.exec("UPDATE outgoing SET updated_at = ? WHERE id = ?", now, id);
      return {
        status: "added",
        attachment: toAttachment(added!),
        revision: this.#row(id)!.revision,
        carried: this.#carried(id),
      };
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
