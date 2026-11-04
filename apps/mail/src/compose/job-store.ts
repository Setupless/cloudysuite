import type { SqlDriver } from "@cloudysuite/object-sql";
import type { MailboxStore } from "../store";
import type { CommitResult, NewMessage } from "../types";
import {
  type AttachmentRow,
  type OutgoingFields,
  type OutgoingRow,
  outgoingFiles,
  outgoingRow,
  SELECT_ROW,
} from "./rows";
import type { OutgoingId, SendFailure } from "./types";

// A claim that never finished is found by this wake-up, and only then, since one
// mailbox's alarm handlers never overlap.
const SENDING_CHECK_MS = 60_000;

export type DueJob = OutgoingFields & { files: AttachmentRow[] };

// The alarm's side of the send job's state machine in types.ts. The person's side is in store.ts.
export class SendJobStore {
  readonly #db: SqlDriver;
  readonly #mail: MailboxStore;

  constructor(db: SqlDriver, mail: MailboxStore) {
    this.#db = db;
    this.#mail = mail;
  }

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
        files: outgoingFiles(this.#db, row.id as OutgoingId),
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
      const row = outgoingRow(this.#db, id)!;
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
