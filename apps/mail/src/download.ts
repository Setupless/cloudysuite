import { downloadHeaders } from "./attachment-headers";
import { openMailboxFor } from "./access";
import type { AttachmentId, MessageId } from "./types";
import { requireMailboxId } from "./wire";

const NOT_FOUND = () =>
  new Response("This file is no longer available.", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

const asPositiveId = <Id>(raw: string): Id | null => {
  const value = Number(raw);
  return /^\d{1,16}$/.test(raw) && value > 0 ? (value as Id) : null;
};

// Thrown refusals are Responses, and these two routes are plain requests rather
// than server functions, so nothing else turns them into a reply.
async function refusalsAsResponses(
  run: () => Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (failure) {
    if (failure instanceof Response) return failure;
    throw failure;
  }
}

export function downloadAttachment(
  request: Request,
  params: { mailboxId: string; messageId: string; attachmentId: string },
): Promise<Response> {
  return refusalsAsResponses(async () => {
    const mailbox = await openMailboxFor(
      request,
      requireMailboxId(params.mailboxId),
    );
    const messageId = asPositiveId<MessageId>(params.messageId);
    const attachmentId = asPositiveId<AttachmentId>(params.attachmentId);
    if (!messageId || !attachmentId) return NOT_FOUND();
    const download = await mailbox.getAttachment(messageId, attachmentId);
    if (!download) return NOT_FOUND();
    return new Response(download.body, {
      headers: downloadHeaders(
        download.info.filename,
        download.info.mimeType,
        download.info.size,
        "attachment",
      ),
    });
  });
}

export function downloadOriginal(
  request: Request,
  params: { mailboxId: string; messageId: string },
): Promise<Response> {
  return refusalsAsResponses(async () => {
    const mailbox = await openMailboxFor(
      request,
      requireMailboxId(params.mailboxId),
    );
    const messageId = asPositiveId<MessageId>(params.messageId);
    if (!messageId) return NOT_FOUND();
    const raw = await mailbox.getRaw(messageId);
    if (!raw) return NOT_FOUND();
    return new Response(raw, {
      headers: downloadHeaders(
        `message-${messageId}.eml`,
        "message/rfc822",
        null,
        "message.eml",
      ),
    });
  });
}
