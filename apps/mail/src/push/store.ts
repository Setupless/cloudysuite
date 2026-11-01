import type { MailboxId, UserId } from "@cloudysuite/access";
import type { SqlDriver, SqlRow } from "../sql";
import type { Folder, MessageId, ThreadId } from "../types";
import { type PushNotice, senderText, subjectText } from "./notice";

// However fast mail arrives, one device hears about it at most this often. The first
// message after a quiet spell goes at once, and the rest wait and become one summary.
export const PUSH_WINDOW_MS = 30_000;
export const MAX_DELIVERY_ATTEMPTS = 5;

// Only the inbox announces. Spam stays quiet, and so does anything rules file away.
export const announces = (folder: Folder): boolean => folder === "inbox";

export type DueDelivery = {
  subscriptionId: string;
  userId: UserId;
  notice: PushNotice;
  attempts: number;
};

export type NewDelivery = { subscriptionId: string; userId: UserId };

type OutboxRow = SqlRow & {
  message_id: number;
  mailbox_id: string;
  thread_id: number;
  from_name: string | null;
  from_address: string | null;
  subject: string | null;
};

type DeliveryRow = SqlRow & {
  subscription_id: string;
  user_id: string;
  notice: string;
  attempts: number;
};

// One mailbox's owed notifications. A message waits in the outbox, a flush turns the
// waiting messages into one notice per device, and each device's row stays until the
// push service answers, so a crash resends rather than forgets. A device owes only
// its newest notice, which is what keeps a flood from growing this table.
export class PushStore {
  readonly #db: SqlDriver;

  constructor(db: SqlDriver) {
    this.#db = db;
  }

  enqueue(messageId: MessageId, mailboxId: MailboxId, now: number): void {
    this.#db.exec(
      "INSERT OR IGNORE INTO push_outbox (message_id, mailbox_id, queued_at) VALUES (?, ?, ?)",
      messageId,
      mailboxId,
      now,
    );
  }

  nextRunAt(): number | null {
    const [row] = this.#db
      .exec<{
        queued: number | null;
        owed: number | null;
        flushed: number | null;
      }>(
        `SELECT
          (SELECT MIN(queued_at) FROM push_outbox) AS queued,
          (SELECT MIN(next_attempt_at) FROM push_deliveries) AS owed,
          (SELECT last_flush_at FROM push_schedule) AS flushed`,
      )
      .toArray();
    const flushDue =
      row?.queued == null
        ? null
        : Math.max(row.queued, (row.flushed ?? 0) + PUSH_WINDOW_MS);
    const due = [flushDue, row?.owed ?? null].filter((time) => time !== null);
    return due.length > 0 ? Math.min(...due) : null;
  }

  newestWaitingId(): MessageId | null {
    const [row] = this.#db
      .exec<{ newest: number | null }>(
        "SELECT MAX(message_id) AS newest FROM push_outbox",
      )
      .toArray();
    return (row?.newest ?? null) as MessageId | null;
  }

  isFlushDue(now: number): boolean {
    const [row] = this.#db
      .exec<{ flushed: number | null; waiting: number }>(
        `SELECT (SELECT last_flush_at FROM push_schedule) AS flushed,
          (SELECT COUNT(*) FROM push_outbox) AS waiting`,
      )
      .toArray();
    return (
      (row?.waiting ?? 0) > 0 && now >= (row?.flushed ?? 0) + PUSH_WINDOW_MS
    );
  }

  // Null when everything waiting has already been read or moved out of the inbox.
  waitingNotice(): { mailboxId: MailboxId; notice: PushNotice } | null {
    const rows = this.#db
      .exec<OutboxRow>(
        `SELECT o.message_id, o.mailbox_id, m.thread_id, m.from_name, m.from_address, m.subject
        FROM push_outbox o JOIN messages m ON m.id = o.message_id
        WHERE m.folder = 'inbox' AND m.is_read = 0
        ORDER BY o.message_id DESC`,
      )
      .toArray();
    const [newest] = rows;
    if (!newest) return null;
    const mailboxId = newest.mailbox_id as MailboxId;
    if (rows.length > 1) {
      return {
        mailboxId,
        notice: { kind: "summary", mailboxId, count: rows.length },
      };
    }
    return {
      mailboxId,
      notice: {
        kind: "message",
        mailboxId,
        threadId: newest.thread_id as ThreadId,
        messageId: newest.message_id as MessageId,
        sender: senderText(newest.from_name || newest.from_address || ""),
        subject: subjectText(newest.subject ?? ""),
      },
    };
  }

  // Message ids only grow, so mail that arrives while this job waits on D1 sits above
  // `upTo` and stays for the next flush.
  flush(
    notice: PushNotice | null,
    devices: readonly NewDelivery[],
    upTo: MessageId,
    flushAt: number,
  ): void {
    this.#db.transaction(() => {
      this.#db.exec("DELETE FROM push_outbox WHERE message_id <= ?", upTo);
      this.#db.exec(
        "INSERT INTO push_schedule (id, last_flush_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_flush_at = excluded.last_flush_at",
        flushAt,
      );
      if (!notice) return;
      const body = JSON.stringify(notice);
      for (const device of devices) {
        this.#db.exec(
          `INSERT INTO push_deliveries (subscription_id, user_id, notice, attempts, next_attempt_at)
          VALUES (?, ?, ?, 0, ?)
          ON CONFLICT (subscription_id) DO UPDATE SET
            user_id = excluded.user_id, notice = excluded.notice,
            attempts = 0, next_attempt_at = excluded.next_attempt_at`,
          device.subscriptionId,
          device.userId,
          body,
          flushAt,
        );
      }
    });
  }

  dueDeliveries(now: number, limit: number): DueDelivery[] {
    return this.#db
      .exec<DeliveryRow>(
        `SELECT subscription_id, user_id, notice, attempts FROM push_deliveries
        WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`,
        now,
        limit,
      )
      .toArray()
      .map((row) => ({
        subscriptionId: row.subscription_id,
        userId: row.user_id as UserId,
        notice: JSON.parse(row.notice) as PushNotice,
        attempts: row.attempts,
      }));
  }

  finish({ subscriptionId }: DueDelivery): void {
    this.#db.exec(
      "DELETE FROM push_deliveries WHERE subscription_id = ?",
      subscriptionId,
    );
  }

  retryAt({ subscriptionId, attempts }: DueDelivery, at: number): void {
    this.#db.exec(
      "UPDATE push_deliveries SET attempts = ?, next_attempt_at = ? WHERE subscription_id = ?",
      attempts + 1,
      at,
      subscriptionId,
    );
  }

  // The rest of a large fan-out waits its turn, so one alarm never runs back to back
  // with the next.
  delayDueDeliveries(until: number, now: number): void {
    this.#db.exec(
      "UPDATE push_deliveries SET next_attempt_at = ? WHERE next_attempt_at <= ?",
      until,
      now,
    );
  }

  // After a failed run, so a job that cannot reach D1 waits instead of waking the
  // alarm again at once.
  postpone(now: number): void {
    this.#db.transaction(() => {
      this.#db.exec(
        "INSERT INTO push_schedule (id, last_flush_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_flush_at = excluded.last_flush_at",
        now,
      );
      this.delayDueDeliveries(now + PUSH_WINDOW_MS, now);
    });
  }

  clear(): void {
    this.#db.transaction(() => {
      this.#db.exec("DELETE FROM push_outbox");
      this.#db.exec("DELETE FROM push_deliveries");
    });
  }

  mutedUsers(): ReadonlySet<UserId> {
    return new Set(
      this.#db
        .exec<{ user_id: string }>("SELECT user_id FROM push_muted_users")
        .toArray()
        .map((row) => row.user_id as UserId),
    );
  }

  isMuted(userId: UserId): boolean {
    return this.mutedUsers().has(userId);
  }

  setMuted(userId: UserId, muted: boolean): void {
    this.#db.exec(
      muted
        ? "INSERT OR IGNORE INTO push_muted_users (user_id) VALUES (?)"
        : "DELETE FROM push_muted_users WHERE user_id = ?",
      userId,
    );
  }
}
