import { Buffer } from "node:buffer";
import type { MailboxClient } from "../client";
import type { AttachmentId, AttachmentInfo, MessageId } from "../types";
import { referencedContentIds, sanitizeEmailHtml } from "./sanitize";

// Only hostile mail reaches this length, or a body nobody reads in a browser tab.
const MAX_RENDERED_CHARACTERS = 2_000_000;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 8 * 1024 * 1024;

// Formats a browser only ever decodes as a picture. SVG can carry script.
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type RenderedBody =
  | {
      kind: "html";
      html: string;
      hasRemoteImages: boolean;
      designed: boolean;
      embedded: AttachmentId[];
    }
  | { kind: "text"; text: string }
  | { kind: "empty" }
  | { kind: "tooLong" };

async function readInlineImages(
  mailbox: MailboxClient,
  messageId: MessageId,
  wanted: ReadonlySet<string>,
) {
  const images = new Map<string, string>();
  const attachmentByContentId = new Map<string, AttachmentInfo>();
  let total = 0;
  for (const info of await mailbox.inlineAttachments(messageId)) {
    const contentId = info.contentId as string;
    if (
      !wanted.has(contentId) ||
      !INLINE_IMAGE_TYPES.has(info.mimeType.toLowerCase()) ||
      info.size > MAX_INLINE_IMAGE_BYTES ||
      total + info.size > MAX_INLINE_TOTAL_BYTES
    ) {
      continue;
    }
    const download = await mailbox.getAttachment(messageId, info.id);
    if (!download) continue;
    const bytes = await new Response(download.body).arrayBuffer();
    total += info.size;
    images.set(
      contentId,
      `data:${info.mimeType.toLowerCase()};base64,${Buffer.from(bytes).toString("base64")}`,
    );
    attachmentByContentId.set(contentId, info);
  }
  return { images, attachmentByContentId };
}

const textBody = (text: string | null): RenderedBody => {
  if (!text?.trim()) return { kind: "empty" };
  return text.length > MAX_RENDERED_CHARACTERS
    ? { kind: "tooLong" }
    : { kind: "text", text };
};

export async function renderBody(
  mailbox: MailboxClient,
  messageId: MessageId,
): Promise<RenderedBody | null> {
  const body = await mailbox.getBody(messageId);
  if (!body) return null;
  if (!body.html?.trim()) return textBody(body.text);
  if (body.html.length > MAX_RENDERED_CHARACTERS) {
    return body.text ? textBody(body.text) : { kind: "tooLong" };
  }

  try {
    const { images, attachmentByContentId } = await readInlineImages(
      mailbox,
      messageId,
      await referencedContentIds(body.html),
    );
    const sanitized = await sanitizeEmailHtml(body.html, images);
    return {
      kind: "html",
      html: sanitized.html,
      hasRemoteImages: sanitized.hasRemoteImages,
      designed: sanitized.designed,
      embedded: sanitized.embeddedContentIds.flatMap((contentId) => {
        const info = attachmentByContentId.get(contentId);
        return info ? [info.id] : [];
      }),
    };
  } catch (error) {
    // The rewriter has a memory limit, and mail can be built to exceed it.
    console.error("Could not prepare a message's HTML for display.", error);
    return body.text ? textBody(body.text) : { kind: "tooLong" };
  }
}
