import { checkMailboxAccess } from "@cloudysuite/access";
import type { MailboxId, UserId } from "../../../../src/db/schema";
import { readSettings } from "../../../../src/settings";
import { mailboxSenderFacts, ownsAddress } from "./addresses";
import type { SendFailure } from "./types";

// A queued message can wait minutes, and the checks made when Send was pressed say
// nothing about now. Null means it may go. Throws when the directory can't answer, and
// the caller must then not send.
export async function reasonNotToSend(
  database: D1Database,
  job: {
    mailboxId: string | null;
    senderId: string | null;
    fromAddress: string;
  },
): Promise<SendFailure | null> {
  if (job.mailboxId === null || job.senderId === null) {
    return "senderLostAccess";
  }
  const mailboxId = job.mailboxId as MailboxId;
  const [settings, access, sender] = await Promise.all([
    readSettings(database),
    checkMailboxAccess(database, job.senderId as UserId, mailboxId),
    mailboxSenderFacts(database, mailboxId),
  ]);
  if (settings.disabled.has("mail")) return "mailOff";
  if (!access.allowed) return "senderLostAccess";
  if (!ownsAddress(sender, job.fromAddress)) return "fromAddressGone";
  return null;
}
