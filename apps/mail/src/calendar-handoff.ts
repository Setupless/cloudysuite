import type { MailboxId } from "@cloudysuite/access";
import {
  type CalendarMail,
  MAX_INVITATION_PART_BYTES,
  MAX_INVITATION_PARTS,
} from "@cloudysuite/calendar/inbound";
import type { SqlDriver, SqlRow } from "@cloudysuite/object-sql";
import { provedSenderDomain } from "./spam/signals";
import type { MessageId, NewMessage } from "./types";

// Calendar reads invitations, updates, cancellations, and replies from inbound mail. Each
// message with a calendar part waits here, written in the transaction that stores it,
// and the alarm hands it over. Only Calendar's one entry for this is called, after the
// message is safe, so nothing Calendar does can lose or hold up mail.

const CALENDAR_TYPES = ["text/calendar", "application/ics"];
const HANDOFFS_PER_WAKE_UP = 10;
// Calendar's answer changes nothing twice, so trying again costs nothing. These tries
// reach an hour apart after an hour, and cover about a day without Calendar.
const MAX_TRIES = 30;
const FIRST_RETRY_MS = 60_000;
const LONGEST_RETRY_MS = 60 * 60_000;

const isCalendarPart = (part: { mimeType: string; size: number }) =>
  CALENDAR_TYPES.includes(part.mimeType) &&
  part.size <= MAX_INVITATION_PART_BYTES;

export const carriesCalendar = (message: NewMessage) =>
  message.attachments.some(isCalendarPart);

type DueRow = SqlRow & {
  message_id: number;
  mailbox_id: string;
  proved: number;
  tries: number;
  from_address: string | null;
};

export type DueHandoff = {
  messageId: MessageId;
  mailboxId: MailboxId;
  from: string | null;
  proved: boolean;
  tries: number;
};

export class CalendarHandoffStore {
  readonly #db: SqlDriver;

  constructor(db: SqlDriver) {
    this.#db = db;
  }

  // Only for a message just stored from inbound mail outside Spam.
  enqueue(
    messageId: MessageId,
    message: NewMessage,
    mailboxId: MailboxId,
    now: number,
  ): void {
    this.#db.exec(
      `INSERT OR IGNORE INTO calendar_handoffs (message_id, mailbox_id, proved, tries, try_at)
       VALUES (?, ?, ?, 0, ?)`,
      messageId,
      mailboxId,
      provedSenderDomain(message) === null ? 0 : 1,
      now,
    );
  }

  due(now: number): DueHandoff[] {
    return this.#db
      .exec<DueRow>(
        `SELECT h.message_id, h.mailbox_id, h.proved, h.tries, m.from_address
         FROM calendar_handoffs h JOIN messages m ON m.id = h.message_id
         WHERE h.try_at <= ? ORDER BY h.try_at LIMIT ?`,
        now,
        HANDOFFS_PER_WAKE_UP,
      )
      .toArray()
      .map((row) => ({
        messageId: row.message_id as MessageId,
        mailboxId: row.mailbox_id as MailboxId,
        from: row.from_address,
        proved: row.proved === 1,
        tries: row.tries,
      }));
  }

  // In the order the message holds them, so the invitation itself comes before a copy
  // of it attached as a file.
  partKeys(messageId: MessageId): string[] {
    return this.#db
      .exec<{ r2_key: string; mime_type: string; size: number }>(
        `SELECT r2_key, mime_type, size FROM attachments WHERE message_id = ?
         ORDER BY position`,
        messageId,
      )
      .toArray()
      .filter((row) =>
        isCalendarPart({ mimeType: row.mime_type, size: row.size }),
      )
      .slice(0, MAX_INVITATION_PARTS)
      .map((row) => row.r2_key);
  }

  finish(messageId: MessageId): void {
    this.#db.exec(
      "DELETE FROM calendar_handoffs WHERE message_id = ?",
      messageId,
    );
  }

  postpone(handoff: DueHandoff, now: number): "later" | "givenUp" {
    if (handoff.tries + 1 >= MAX_TRIES) {
      this.finish(handoff.messageId);
      return "givenUp";
    }
    this.#db.exec(
      "UPDATE calendar_handoffs SET tries = tries + 1, try_at = ? WHERE message_id = ?",
      now + Math.min(FIRST_RETRY_MS * 2 ** handoff.tries, LONGEST_RETRY_MS),
      handoff.messageId,
    );
    return "later";
  }

  nextRunAt(): number | null {
    const [row] = this.#db
      .exec<{ next: number | null }>(
        "SELECT MIN(try_at) AS next FROM calendar_handoffs",
      )
      .toArray();
    return row?.next ?? null;
  }
}

export async function runDueHandoffs(
  store: CalendarHandoffStore,
  bucket: R2Bucket,
  deliver: (mail: CalendarMail) => Promise<void>,
  now: number,
): Promise<void> {
  for (const handoff of store.due(now)) {
    try {
      const parts = await Promise.all(
        store.partKeys(handoff.messageId).map(async (key) => {
          const object = await bucket.get(key);
          return object ? await object.text() : null;
        }),
      );
      await deliver({
        mailboxId: handoff.mailboxId,
        from: handoff.from,
        proved: handoff.proved,
        parts: parts.filter((part) => part !== null),
      });
      store.finish(handoff.messageId);
    } catch (error) {
      console.error(
        store.postpone(handoff, Date.now()) === "later"
          ? "Could not hand an invitation to Calendar. It will try again."
          : `Gave up handing an invitation to Calendar after ${MAX_TRIES} tries. The email stays in the mailbox as it came.`,
        error,
      );
    }
  }
}
