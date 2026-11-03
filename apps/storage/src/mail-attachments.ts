import { env } from "cloudflare:workers";
import type { DriveId, MailboxId, UserId } from "@cloudysuite/access";
import { openMailboxAs } from "@cloudysuite/mail/access";
import type { AttachmentId, MessageId } from "@cloudysuite/mail/client";
import {
  expectedPartBytes,
  PART_BYTES,
  partCountFor,
  readUpTo,
  type Refused,
} from "@cloudysuite/transfer";
import { and, eq, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { isAppOff } from "../../../src/app-on";
import {
  mailboxAccess,
  savedMailAttachments as saved,
} from "../../../src/db/schema";
import { openDriveAs } from "./access";
import { ensureMyDrive } from "./my-drive";
import { cleanItemName, withoutHiddenCharacters } from "./names";
import { type ItemId } from "./types";
import { refusal } from "./wire";

const ROWS_SHOWN = 5;
// Each part renews it, so this only has to outlast one part. A save that crashed holds
// the attachment for this long, and then a retry carries on from the parts it stored.
const CLAIM_MS = 2 * 60 * 1000;
const NO_SENDER = "an unknown sender";

const GONE =
  "This attachment is no longer in your mail, so it wasn't saved. It may have been moved to Spam or Trash, or deleted.";
const BUSY =
  "This attachment is already being saved. Give it a moment, then reload the page.";
const COULD_NOT_SAVE =
  "We couldn't finish saving this attachment. Nothing is lost. Try again in a moment.";
export const MAIL_OFF =
  "An admin turned Mail off, so attachments can't be saved from it. Nothing was changed, and you can save them when it's turned on again.";

export type MailAttachmentKey = {
  mailboxId: MailboxId;
  messageId: MessageId;
  attachmentId: AttachmentId;
};

export type MailAttachmentRow = MailAttachmentKey & {
  name: string;
  mimeType: string;
  sender: string;
  receivedAt: number;
  saved: boolean;
};

const whereKey = (userId: UserId, key: MailAttachmentKey) =>
  and(
    eq(saved.userId, userId),
    eq(saved.mailboxId, key.mailboxId),
    eq(saved.messageId, key.messageId),
    eq(saved.attachmentId, key.attachmentId),
  );

// Keeps a row saved if My files can't answer, and offers the save again only once the
// copy is known to be gone.
async function copyStillThere(
  userId: UserId,
  driveId: DriveId,
  itemId: string | null,
): Promise<boolean> {
  if (itemId === null) return false;
  const drive = await openDriveAs(userId, driveId);
  return (await drive.file(itemId as ItemId)) !== null;
}

// A parser hands back an empty name for a bare address, and either can be all hidden
// characters, so each gets its turn.
const senderOf = (row: {
  fromName: string | null;
  fromAddress: string | null;
}) =>
  withoutHiddenCharacters(row.fromName ?? "") ||
  withoutHiddenCharacters(row.fromAddress ?? "") ||
  NO_SENDER;

// One mailbox failing leaves out that mailbox. Only the row on Home is at stake, so
// nothing here may fail louder than that.
export async function listMailAttachments(
  userId: UserId,
): Promise<MailAttachmentRow[]> {
  if (await isAppOff(env.DB, "mail")) return [];
  const db = drizzle(env.DB);
  const reachable = await db
    .select({ mailboxId: mailboxAccess.mailboxId })
    .from(mailboxAccess)
    .where(eq(mailboxAccess.userId, userId));

  const lists = await Promise.all(
    reachable.map(async ({ mailboxId }) => {
      try {
        const mailbox = await openMailboxAs(userId, mailboxId);
        const found = await mailbox.recentAttachments(ROWS_SHOWN);
        return found.map((attachment) => ({ ...attachment, mailboxId }));
      } catch (failure) {
        console.error("Could not read a mailbox's attachments.", failure);
        return [];
      }
    }),
  );
  const newest = lists
    .flat()
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, ROWS_SHOWN);
  if (newest.length === 0) return [];

  const records = await db
    .select()
    .from(saved)
    .where(or(...newest.map((row) => whereKey(userId, row))));
  const recordOf = (row: (typeof newest)[number]) =>
    records.find(
      (record) =>
        record.savedAt !== null &&
        record.mailboxId === row.mailboxId &&
        record.messageId === row.messageId &&
        record.attachmentId === row.attachmentId,
    );

  return Promise.all(
    newest.map(async (row) => {
      const record = recordOf(row);
      const isSaved = record
        ? await copyStillThere(userId, record.driveId, record.itemId).catch(
            () => true,
          )
        : false;
      return {
        mailboxId: row.mailboxId,
        messageId: row.messageId,
        attachmentId: row.attachmentId,
        name: cleanItemName(row.filename),
        mimeType: row.mimeType,
        sender: senderOf(row),
        receivedAt: row.receivedAt,
        saved: isSaved,
      };
    }),
  );
}

// Only a limit is worth repeating to the person. An upload's other refusals talk about
// choosing a file again, and nobody here chose one.
const refusalOf = (refused: Refused) =>
  refused.status === 413
    ? refusal(413, refused.message)
    : refusal(500, COULD_NOT_SAVE);

// Copies in the Worker through Storage's own upload path, so the bytes pass through
// neither object, and whatever that path decides about limits, names, types, and usage
// applies here too. Holds one part in memory at a time.
//
// Safe to repeat. Only one save of an attachment runs at a time, and the upload's id is
// on record before the commit that makes it a file, so any retry finds that file.
export async function saveMailAttachment(
  userId: UserId,
  key: MailAttachmentKey,
): Promise<void> {
  const { mailboxId, messageId, attachmentId } = key;
  if (await isAppOff(env.DB, "mail")) throw refusal(403, MAIL_OFF);
  const mailbox = await openMailboxAs(userId, mailboxId);

  const db = drizzle(env.DB);
  const [record] = await db.select().from(saved).where(whereKey(userId, key));
  if (
    record?.savedAt &&
    (await copyStillThere(userId, record.driveId, record.itemId))
  ) {
    return;
  }

  const attachment = await mailbox.listedAttachment(messageId, attachmentId);
  if (!attachment) throw refusal(404, GONE);

  const driveId = await ensureMyDrive(userId);
  const drive = await openDriveAs(userId, driveId);

  const untilLater = () => new Date(Date.now() + CLAIM_MS);
  const [claim] = await db
    .insert(saved)
    .values({ ...key, userId, driveId, claimedUntil: untilLater() })
    .onConflictDoUpdate({
      target: [
        saved.userId,
        saved.mailboxId,
        saved.messageId,
        saved.attachmentId,
      ],
      set: { driveId, savedAt: null, claimedUntil: untilLater() },
      setWhere: lte(saved.claimedUntil, new Date()),
    })
    .returning({ itemId: saved.itemId });
  if (!claim) throw refusal(409, BUSY);

  const finish = (itemId: string) =>
    db
      .update(saved)
      .set({ itemId, savedAt: new Date(), claimedUntil: new Date(0) })
      .where(whereKey(userId, key));

  try {
    if (
      claim.itemId !== null &&
      (await drive.file(claim.itemId as ItemId)) !== null
    ) {
      await finish(claim.itemId);
      return;
    }

    const started = await drive.uploads.start({
      parentId: null,
      name: cleanItemName(attachment.filename),
      size: attachment.size,
      mimeType: attachment.mimeType,
      fingerprint: `mail:${mailboxId}:${messageId}:${attachmentId}`,
    });
    if (!started.ok) throw refusalOf(started);
    const upload = started.value;
    await db
      .update(saved)
      .set({ itemId: upload.id })
      .where(whereKey(userId, key));

    for (let part = 1; part <= partCountFor(upload.size); part += 1) {
      if (upload.storedParts.includes(part)) continue;
      const length = expectedPartBytes(upload.size, part);
      const stored = await drive.uploads.putPart(upload.id, part, {
        declaredBytes: length,
        // Opens the mailbox again, so losing access or moving the mail away stops a
        // save that's under way.
        read: async (limit) => {
          const current = await openMailboxAs(userId, mailboxId);
          const body = await current.readListedAttachment(
            messageId,
            attachmentId,
            { offset: (part - 1) * PART_BYTES, length },
          );
          if (!body) throw refusal(404, GONE);
          return readUpTo(body, limit);
        },
      });
      if (!stored.ok) throw refusalOf(stored);
      await db
        .update(saved)
        .set({ claimedUntil: untilLater() })
        .where(whereKey(userId, key));
    }

    const completed = await drive.uploads.complete(upload.id);
    if (!completed.ok) throw refusalOf(completed);
    await finish(completed.value.id);
  } catch (failure) {
    await db
      .update(saved)
      .set({ claimedUntil: new Date(0) })
      .where(whereKey(userId, key))
      .catch(() => {});
    if (failure instanceof Response) throw failure;
    console.error("Could not save a mail attachment.", failure);
    throw refusal(500, COULD_NOT_SAVE);
  }
}
