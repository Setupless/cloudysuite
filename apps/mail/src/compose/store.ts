import type { MailboxId } from "@cloudysuite/access";
import type { SqlDriver } from "@cloudysuite/object-sql";
import type { MailboxStore } from "../store";
import type { Address, AttachmentId, MessageId, ThreadId } from "../types";
import { outgoingPrefix } from "../r2-keys";
import { holdsSomethingAdded } from "./added";
import { nextCopyId } from "./copy-id";
import {
  type AttachmentRow,
  type OutgoingRow,
  outgoingFiles,
  outgoingRow,
  SELECT_ROW,
} from "./rows";
import type {
  ComposeMode,
  DiscardResult,
  DraftBase,
  DraftChange,
  DraftContent,
  DraftHolds,
  DraftPrefill,
  Editor,
  OutgoingAttachment,
  OutgoingDetail,
  OutgoingId,
  OutgoingState,
  OutgoingSummary,
  ParentFacts,
  RemoveAttachmentResult,
  SaveIntent,
  SaveResult,
} from "./types";
import {
  fitsSendLimit,
  isHeld,
  writtenBytes,
  MAX_ATTACHMENTS,
  NOTHING_PREFILLED,
  TOO_LARGE_TEXT,
  TOO_MANY_ATTACHMENTS_TEXT,
  UNDO_WINDOW_MS,
} from "./types";

const FINISHED_KEPT_MS = 24 * 60 * 60 * 1000;
const SENT_NOTE_KEPT_MS = 60 * 60 * 1000;
const SNIPPET_LENGTH = 140;

const addressesIn = (json: string) => JSON.parse(json) as Address[];

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

const parentOf = (row: OutgoingRow): ParentFacts | null =>
  row.parent_message_id === null
    ? null
    : {
        messageId: row.parent_message_id as MessageId,
        rfcMessageId: row.parent_rfc_id,
        references: JSON.parse(row.parent_refs) as string[],
      };

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
    isCopy: row.copied_from !== null,
  };
}

// Words from a device can ask for a quote that only the row it was written on had.
const withQuoteOnlyIfHeld = (
  content: DraftContent,
  row: OutgoingRow | null,
  create?: NewOutgoing,
): DraftContent =>
  (row ? row.quote_bytes : create?.quote) == null
    ? { ...content, includeQuote: false }
    : content;

const holdsWords = (row: OutgoingRow, content: DraftContent): boolean =>
  row.from_address === content.from &&
  row.to_addresses === JSON.stringify(content.to) &&
  row.cc_addresses === JSON.stringify(content.cc) &&
  row.bcc_addresses === JSON.stringify(content.bcc) &&
  row.subject === content.subject &&
  row.html === content.html;

const holdsContent = (row: OutgoingRow, content: DraftContent): boolean =>
  holdsWords(row, content) &&
  (row.include_quote === 1) === content.includeQuote;

const isBehind = (row: OutgoingRow, base: DraftBase): boolean =>
  row.revision !== base.baseRevision && row.last_session !== base.session;

const changeBy = (row: OutgoingRow, editor: Editor): DraftChange => ({
  by: row.updated_by === editor.id ? null : row.updated_by_name,
});

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

export type ScheduleResult =
  | { status: "scheduled" }
  | { status: "behind" }
  | { status: "locked"; state: OutgoingState };

export type AddAttachmentResult =
  | {
      status: "added";
      attachment: OutgoingAttachment;
      revision: number;
      carried: OutgoingAttachment[];
    }
  | { status: "behind" }
  | { status: "refused"; httpStatus: number; message: string };

export type NewFile = {
  filename: string;
  mime_type: string;
  size: number;
  r2_key: string;
  carried_from: number | null;
  source: number;
};

// What a new draft beside another still needs copied, which only the Worker can do,
// because file bytes never pass through the Durable Object. The words are already safe.
export type CopyCarry = {
  fromPrefix: string;
  toPrefix: string;
  quote: { bytes: number; designed: boolean } | null;
  files: NewFile[];
};

export type StoredSave =
  | Exclude<SaveResult, { status: "copied" }>
  | (Extract<SaveResult, { status: "copied" }> & { carry: CopyCarry | null });

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

// The person's side of the send job's state machine in types.ts: drafts, Send, Undo, and
// files. The alarm's side is in job-store.ts.
export class OutgoingStore {
  readonly #db: SqlDriver;
  readonly #mail: MailboxStore;

  constructor(db: SqlDriver, mail: MailboxStore) {
    this.#db = db;
    this.#mail = mail;
  }

  detail(
    id: OutgoingId,
    viewerId: string,
    now = Date.now(),
  ): OutgoingDetail | null {
    const row = outgoingRow(this.#db, id);
    if (!row) return null;
    return {
      ...toSummary(row, viewerId, now),
      revision: row.revision,
      parent: parentOf(row),
      content: {
        from: row.from_address,
        to: addressesIn(row.to_addresses),
        cc: addressesIn(row.cc_addresses),
        bcc: addressesIn(row.bcc_addresses),
        subject: row.subject,
        html: row.html,
        includeQuote: row.include_quote === 1,
      },
      attachments: outgoingFiles(this.#db, id).map(toAttachment),
      quote:
        row.quote_bytes === null
          ? null
          : { bytes: row.quote_bytes, designed: row.quote_designed === 1 },
      prefill: prefillOf(row),
    };
  }

  #carried(id: OutgoingId): OutgoingAttachment[] {
    return outgoingFiles(this.#db, id)
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
    session: string,
    now: number,
  ): number {
    const [row] = this.#db
      .exec<{ revision: number }>(
        `UPDATE outgoing SET
           revision = revision + 1, from_address = ?, to_addresses = ?, cc_addresses = ?,
           bcc_addresses = ?, subject = ?, html = ?, body_text = ?, include_quote = ?,
           updated_by = ?, updated_by_name = ?, updated_at = ?, last_session = ?
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
        session,
        id,
      )
      .toArray();
    return row!.revision;
  }

  // A file changing is a change to the draft, so a save based on what came before it
  // can't land over a set of files its writer never saw, or send one of them.
  #bump(id: OutgoingId, editor: Editor, session: string, now: number): number {
    const [row] = this.#db
      .exec<{ revision: number }>(
        `UPDATE outgoing SET
           revision = revision + 1, updated_by = ?, updated_by_name = ?, updated_at = ?, last_session = ?
         WHERE id = ? RETURNING revision`,
        editor.id,
        editor.name,
        now,
        session,
        id,
      )
      .toArray();
    return row!.revision;
  }

  #holds(id: OutgoingId): DraftHolds {
    const row = outgoingRow(this.#db, id)!;
    const files = outgoingFiles(this.#db, id);
    return {
      attachmentIds: files.flatMap((file) =>
        file.copied_from_file === null
          ? [file.id]
          : [file.id, file.copied_from_file],
      ),
      carriedFrom: files.flatMap((file) => file.carried_from ?? []),
      quote: row.quote_bytes !== null,
      threaded: row.parent_message_id !== null,
    };
  }

  // Each save is an update to one row, so autosave cannot pile up messages. A save based
  // on an older version never touches the draft: its words become a new draft beside it,
  // and the check and the write share this transaction, so no save can land between them.
  // Holding nothing anyone added writes nothing, so a row always keeps the last words it
  // had. It goes only when the person leaves, and not if someone has saved since they
  // last looked, because those are words this person hasn't seen.
  save(
    input: SaveIntent & {
      id: OutgoingId;
      copyId: OutgoingId;
      mailboxId: MailboxId;
      content: DraftContent;
      plainText: string;
      editor: Editor;
      r2Prefix: string;
      create?: NewOutgoing;
      leaving?: boolean;
    },
    now = Date.now(),
  ): StoredSave {
    return this.#db.transaction(() => {
      const { id, session, plainText, editor, r2Prefix, create } = input;
      const row = outgoingRow(this.#db, id);
      const content = withQuoteOnlyIfHeld(input.content, row, create);
      const onItsWay = row !== null && row.state !== "draft";
      if (onItsWay && input.whenLocked === "report") {
        return { status: "locked", state: row.state };
      }
      const behind = row !== null && (onItsWay || isBehind(row, input));
      const holds =
        (behind && input.fileComing) ||
        holdsSomethingAdded(
          { content, uploads: row?.upload_count ?? 0 },
          row ? prefillOf(row) : (create?.prefill ?? NOTHING_PREFILLED),
        );
      if (!holds) {
        if (!row || !input.leaving) return { status: "nothing" };
        if (behind) return { status: "changed" };
        this.#remove(row);
        return { status: "removed" };
      }
      if (!row) {
        this.#create(create ?? plainRow(id, content, r2Prefix, editor), now);
      }
      if (!behind) {
        return {
          status: "saved",
          revision: this.#writeContent(
            id,
            content,
            plainText,
            editor,
            session,
            now,
          ),
          holds: this.#holds(id),
          carried: this.#carried(id),
        };
      }
      const held = this.#holds(id);
      const sameFiles =
        input.showing.every((file) => isHeld(file, held)) &&
        input.showing.length === outgoingFiles(this.#db, id).length;
      if (!onItsWay && sameFiles && holdsContent(row, content)) {
        return {
          status: "saved",
          revision: row.revision,
          holds: held,
          carried: this.#carried(id),
        };
      }
      return this.#saveBeside(row, content, input, now);
    });
  }

  #saveBeside(
    row: OutgoingRow,
    content: DraftContent,
    input: SaveIntent & {
      copyId: OutgoingId;
      mailboxId: MailboxId;
      plainText: string;
      editor: Editor;
    },
    now: number,
  ): StoredSave {
    const { session, plainText, editor } = input;
    const changed = row.state === "draft" ? changeBy(row, editor) : null;
    const answer = (
      copy: OutgoingRow,
      revision: number,
      carry: CopyCarry | null,
    ) => ({
      status: "copied" as const,
      id: copy.id as OutgoingId,
      state: copy.state,
      revision,
      holds: this.#holds(copy.id as OutgoingId),
      files: outgoingFiles(this.#db, copy.id as OutgoingId).map(toAttachment),
      changed,
      carry,
    });

    let copyId = input.copyId;
    let mine = outgoingRow(this.#db, copyId);
    while (mine && mine.last_session !== session) {
      copyId = nextCopyId(copyId);
      mine = outgoingRow(this.#db, copyId);
    }
    if (mine) {
      const revision =
        mine.state === "draft"
          ? this.#writeContent(
              copyId,
              withQuoteOnlyIfHeld(content, mine),
              plainText,
              editor,
              session,
              now,
            )
          : mine.revision;
      return answer(outgoingRow(this.#db, copyId)!, revision, null);
    }

    if (!input.written) {
      return { status: "behind", changed };
    }
    const files = outgoingFiles(this.#db, row.id as OutgoingId).filter((file) =>
      input.showing.some((shown) =>
        isHeld(shown, {
          attachmentIds: [file.id],
          carriedFrom: file.carried_from ? [file.carried_from] : [],
          quote: false,
          threaded: false,
        }),
      ),
    );
    const prefill = prefillOf(row);
    if (
      !input.fileComing &&
      !holdsSomethingAdded(
        {
          content,
          uploads: files.filter((file) => file.carried_from === null).length,
        },
        prefill,
      )
    ) {
      return { status: "nothing" };
    }
    // Two tabs bringing back the same words get one new draft between them.
    const same = this.#db
      .exec<OutgoingRow>(
        `${SELECT_ROW} WHERE o.copied_from = ? AND o.state = 'draft'`,
        row.id,
      )
      .toArray()
      .find((copy) => holdsWords(copy, content));
    if (same) return answer(same, same.revision, null);

    const toPrefix = outgoingPrefix(input.mailboxId, copyId);
    const withoutQuote = { ...content, includeQuote: false };
    this.#create(
      {
        id: copyId,
        mode: row.mode,
        parent: parentOf(row),
        prefill,
        content: withoutQuote,
        r2Prefix: toPrefix,
        quote: null,
        attachments: [],
        editor,
      },
      now,
    );
    this.#db.exec(
      "UPDATE outgoing SET copied_from = ? WHERE id = ?",
      row.id,
      copyId,
    );
    const revision = this.#writeContent(
      copyId,
      withoutQuote,
      plainText,
      editor,
      session,
      now,
    );
    const quote =
      content.includeQuote && row.quote_bytes !== null
        ? { bytes: row.quote_bytes, designed: row.quote_designed === 1 }
        : null;
    const carry =
      quote || files.length > 0
        ? {
            fromPrefix: row.r2_prefix,
            toPrefix,
            quote,
            files: files.map((file) => ({
              filename: file.filename,
              mime_type: file.mime_type,
              size: file.size,
              r2_key: file.r2_key,
              carried_from: file.carried_from,
              source: file.id,
            })),
          }
        : null;
    return answer(outgoingRow(this.#db, copyId)!, revision, carry);
  }

  // What the Worker managed to copy. Anything it couldn't stays out, and the person is told.
  carryIntoCopy(
    id: OutgoingId,
    carried: Pick<CopyCarry, "quote" | "files">,
  ): { holds: DraftHolds; files: OutgoingAttachment[] } | null {
    return this.#db.transaction(() => {
      if (!outgoingRow(this.#db, id)) return null;
      if (carried.quote) {
        this.#db.exec(
          "UPDATE outgoing SET quote_bytes = ?, quote_designed = ?, include_quote = 1 WHERE id = ?",
          carried.quote.bytes,
          carried.quote.designed ? 1 : 0,
          id,
        );
      }
      for (const file of carried.files) {
        this.#db.exec(
          "INSERT INTO outgoing_attachments (outgoing_id, filename, mime_type, size, r2_key, carried_from, copied_from_file) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id,
          file.filename,
          file.mime_type,
          file.size,
          file.r2_key,
          file.carried_from,
          file.source,
        );
      }
      return {
        holds: this.#holds(id),
        files: outgoingFiles(this.#db, id).map(toAttachment),
      };
    });
  }

  // Pressing Send twice, or a retried request, finds it already scheduled and leaves
  // the undo window where it was. Anyone else's send means these words can't join it, and
  // a draft that has moved on goes back to the screen, which sends from its own new draft.
  schedule(
    input: DraftBase & {
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
      const { id, plainText, editor, r2Prefix, fromName, mailboxId, session } =
        input;
      const row = outgoingRow(this.#db, id);
      const content = withQuoteOnlyIfHeld(input.content, row, input.create);
      if (row?.state === "scheduled" && row.last_session === session) {
        return { status: "scheduled" };
      }
      if (row && row.state !== "draft") {
        return { status: "locked", state: row.state };
      }
      if (row && isBehind(row, input)) return { status: "behind" };
      if (!row) {
        this.#create(
          input.create ?? plainRow(id, content, r2Prefix, editor),
          now,
        );
      }
      this.#writeContent(id, content, plainText, editor, session, now);
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
  // path to get wrong: its row goes now, and its files follow through the queue. Words
  // saved since this person last looked aren't theirs to throw away.
  discard(
    input: DraftBase & { id: OutgoingId; editor: Editor },
  ): DiscardResult {
    return this.#db.transaction(() => {
      const row = outgoingRow(this.#db, input.id);
      if (!row || !["draft", "failed", "unknown"].includes(row.state)) {
        return { status: "gone" };
      }
      if (isBehind(row, input)) {
        return { status: "behind", changed: changeBy(row, input.editor) };
      }
      this.#remove(row);
      return { status: "discarded" };
    });
  }

  #remove(row: OutgoingRow): void {
    this.#db.exec("DELETE FROM outgoing WHERE id = ?", row.id);
    this.#mail.queueDeletion(row.r2_prefix);
  }

  // Checks the limits again in the transaction, because two uploads can pass the
  // earlier check at once. The caller removes the file if this refuses it. A draft that
  // has moved on gets no file from someone looking at an older version of it.
  addAttachment(
    input: DraftBase & {
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
      const row = outgoingRow(this.#db, id);
      if (row && row.state !== "draft") {
        return {
          status: "refused",
          httpStatus: 409,
          message:
            "This message is already on its way, so it can't take more files.",
        };
      }
      if (row && isBehind(row, input)) return { status: "behind" };
      const existing = row
        ? outgoingFiles(this.#db, id)
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
           RETURNING id, filename, mime_type, size, r2_key, carried_from, copied_from_file`,
          id,
          filename,
          mimeType,
          size,
          r2Key,
        )
        .toArray();
      return {
        status: "added",
        attachment: toAttachment(added!),
        revision: this.#bump(id, editor, input.session, now),
        carried: this.#carried(id),
      };
    });
  }

  // Locked while the message is on its way, because the send still needs the file.
  removeAttachment(
    input: DraftBase & {
      id: OutgoingId;
      attachmentId: number;
      editor: Editor;
    },
    now = Date.now(),
  ): RemoveAttachmentResult {
    return this.#db.transaction(() => {
      const { id, attachmentId, editor, session } = input;
      const row = outgoingRow(this.#db, id);
      if (!row) return { status: "removed", revision: null };
      if (row.state !== "draft") return { status: "locked" };
      if (isBehind(row, input)) return { status: "behind" };
      const [removed] = this.#db
        .exec<{ r2_key: string }>(
          "DELETE FROM outgoing_attachments WHERE id = ? AND outgoing_id = ? RETURNING r2_key",
          attachmentId,
          id,
        )
        .toArray();
      if (!removed) return { status: "removed", revision: row.revision };
      this.#mail.queueDeletion(removed.r2_key);
      return {
        status: "removed",
        revision: this.#bump(id, editor, session, now),
      };
    });
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
}
