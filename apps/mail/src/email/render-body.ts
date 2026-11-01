import { Buffer } from "node:buffer";
import type { MailboxClient } from "../client";
import type { AttachmentId, AttachmentInfo, MessageId } from "../types";
import { referencedContentIds, sanitizeEmailHtml } from "./sanitize";

// Only hostile mail reaches this length, or a body nobody reads in a browser tab.
const MAX_RENDERED_CHARACTERS = 2_000_000;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_TOTAL_BYTES = 8 * 1024 * 1024;

const startsWith = (bytes: Uint8Array, ...signature: number[]) =>
  signature.every((value, index) => bytes[index] === value);

// Formats a browser only ever decodes as a picture. SVG can carry script. The
// declared type comes from the sender, so the file's first bytes have to agree.
const INLINE_IMAGE_SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> =
  {
    "image/png": (bytes) =>
      startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    "image/jpeg": (bytes) => startsWith(bytes, 0xff, 0xd8, 0xff),
    "image/gif": (bytes) =>
      startsWith(bytes, 0x47, 0x49, 0x46, 0x38) &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) &&
      bytes[5] === 0x61,
    "image/webp": (bytes) =>
      startsWith(bytes, 0x52, 0x49, 0x46, 0x46) &&
      startsWith(bytes.subarray(8), 0x57, 0x45, 0x42, 0x50),
  };

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
    const type = info.mimeType.toLowerCase();
    const matchesType = Object.hasOwn(INLINE_IMAGE_SIGNATURES, type)
      ? INLINE_IMAGE_SIGNATURES[type]
      : undefined;
    if (
      !wanted.has(contentId) ||
      !matchesType ||
      info.size > MAX_INLINE_IMAGE_BYTES ||
      total + info.size > MAX_INLINE_TOTAL_BYTES
    ) {
      continue;
    }
    const download = await mailbox.getAttachment(messageId, info.id);
    if (!download) continue;
    const bytes = new Uint8Array(
      await new Response(download.body).arrayBuffer(),
    );
    if (!matchesType(bytes)) continue;
    total += info.size;
    images.set(
      contentId,
      `data:${type};base64,${Buffer.from(bytes).toString("base64")}`,
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
  ownDomain: string,
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
    const sanitized = await sanitizeEmailHtml(body.html, images, ownDomain);
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
