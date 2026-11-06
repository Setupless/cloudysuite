import type { MailboxId } from "@cloudysuite/access";
import {
  type CalendarMail,
  MAX_INVITATION_PART_BYTES,
  MAX_INVITATION_PARTS,
} from "@cloudysuite/calendar/inbound";
import type { SqlDriver, SqlRow } from "@cloudysuite/object-sql";
import { provedSenderDomain } from "./spam/signals";
import { CALENDAR_TYPES, type MessageId, type NewMessage } from "./types";

// Calendar reads invitations, updates, cancellations, and replies from inbound mail. Each
// message with a calendar part waits here, written once the message is stored, and the
// alarm hands it over. Only Calendar's one entry for this is called, after the message
// is safe, so nothing Calendar does can lose or hold up mail.

// Each hand-off waits on the directory and on calendars, so a run hands over a few and
// starts none after its budget. The alarm comes straight back for the rest, and the
// mailbox takes other mail in between.
const HANDOFFS_PER_WAKE_UP = 3;
const RUN_BUDGET_MS = 1_000;
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
  in_spam: number;
};

export type DueHandoff = {
  messageId: MessageId;
  mailboxId: MailboxId;
  from: string | null;
  proved: boolean;
  tries: number;
  // Someone can move it to Spam before the alarm runs, which counts as the filter would.
  inSpam: boolean;
};

export type CardRefs = {
  from: string | null;
  proved: boolean;
  partKeys: string[];
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
        `SELECT h.message_id, h.mailbox_id, h.proved, h.tries, m.from_address,
           m.folder = 'spam' AS in_spam
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
        inSpam: row.in_spam === 1,
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

  // What the invitation card in Mail reads, from any folder and any source, since the
  // person chose to open it.
  forCard(messageId: MessageId): CardRefs | null {
    const [row] = this.#db
      .exec<{ from_address: string | null; sender_proved: number }>(
        "SELECT from_address, sender_proved FROM messages WHERE id = ?",
        messageId,
      )
      .toArray();
    return row
      ? {
          from: row.from_address,
          proved: row.sender_proved === 1,
          partKeys: this.partKeys(messageId),
        }
      : null;
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
    if (handoff.inSpam) {
      store.finish(handoff.messageId);
      continue;
    }
    if (Date.now() - now >= RUN_BUDGET_MS) return;
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
