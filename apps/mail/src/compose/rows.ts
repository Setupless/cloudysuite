import type { SqlDriver, SqlRow } from "@cloudysuite/object-sql";
import type {
  ComposeMode,
  OutgoingId,
  OutgoingState,
  SendFailure,
} from "./types";

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
