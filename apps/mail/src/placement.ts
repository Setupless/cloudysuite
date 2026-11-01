import type { SqlDriver } from "./sql";
import type { Folder, NewMessage } from "./types";

export type Placement = { folder: Folder; read: boolean };

// Rules and spam scoring plug in here. They run inside the commit transaction,
// so a retry cannot apply them twice, and they can read the mailbox's own tables.
// A verdict can only choose where a message goes: spam is never rejected.
export function triageInbound(_message: NewMessage, _db: SqlDriver): Placement {
  return { folder: "inbox", read: false };
}

// Imported and sent mail never reaches triage, so rules and spam skip it.
export function placementFor(message: NewMessage, db: SqlDriver): Placement {
  switch (message.source) {
    case "inbound":
      return triageInbound(message, db);
    case "import":
      return { folder: "archive", read: true };
    case "sent":
      return { folder: "sent", read: true };
  }
}
