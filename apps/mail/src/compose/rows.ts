import type { SqlDriver, SqlRow } from "@cloudysuite/object-sql";
import type { Address, AttachmentId, MessageId, ThreadId } from "../types";
import { holdsSomethingAdded } from "./added";
import type {
  ComposeMode,
  DraftPrefill,
  OutgoingAttachment,
  OutgoingId,
  OutgoingState,
  OutgoingSummary,
  ParentFacts,
  SendFailure,
} from "./types";

const SNIPPET_LENGTH = 140;

export type OutgoingFields = {
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
  last_session: string | null;
  copied_from: string | null;
};

export type OutgoingRow = SqlRow & OutgoingFields;

export type AttachmentRow = SqlRow & {
  id: number;
  filename: string;
  mime_type: string;
  size: number;
  r2_key: string;
  carried_from: number | null;
  copied_from_file: number | null;
};

export const SELECT_ROW = `
  SELECT o.*,
    COALESCE(
      (SELECT thread_id FROM messages WHERE id = o.stored_message_id),
      (SELECT thread_id FROM messages WHERE id = o.parent_message_id)
    ) AS thread_id,
    (SELECT COUNT(*) FROM outgoing_attachments a WHERE a.outgoing_id = o.id) AS attachment_count,
    (SELECT COUNT(*) FROM outgoing_attachments a WHERE a.outgoing_id = o.id AND a.carried_from IS NULL) AS upload_count
  FROM outgoing o`;

export function outgoingRow(db: SqlDriver, id: OutgoingId): OutgoingRow | null {
  const [row] = db
    .exec<OutgoingRow>(`${SELECT_ROW} WHERE o.id = ?`, id)
    .toArray();
  return row ?? null;
}

export function outgoingFiles(db: SqlDriver, id: OutgoingId): AttachmentRow[] {
  return db
    .exec<AttachmentRow>(
      "SELECT id, filename, mime_type, size, r2_key, carried_from, copied_from_file FROM outgoing_attachments WHERE outgoing_id = ? ORDER BY id",
      id,
    )
    .toArray();
}

export const addressesIn = (json: string) => JSON.parse(json) as Address[];

export const toAttachment = (row: AttachmentRow): OutgoingAttachment => ({
  id: row.id,
  filename: row.filename,
  mimeType: row.mime_type,
  size: row.size,
  carriedFrom: row.carried_from as AttachmentId | null,
});

export const prefillOf = (row: OutgoingRow): DraftPrefill => ({
  to: addressesIn(row.prefill_to),
  cc: addressesIn(row.prefill_cc),
  subject: row.prefill_subject,
});

export const holdsSomething = (row: OutgoingRow) =>
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

export const parentOf = (row: OutgoingRow): ParentFacts | null =>
  row.parent_message_id === null
    ? null
    : {
        messageId: row.parent_message_id as MessageId,
        rfcMessageId: row.parent_rfc_id,
        references: JSON.parse(row.parent_refs) as string[],
      };

export function toSummary(
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
