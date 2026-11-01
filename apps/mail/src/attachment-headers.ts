// Formats a browser cannot run as a page. Every other type downloads as plain
// bytes, because a type here comes from the sender and cannot be trusted.
const PASSIVE_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/calendar",
  "text/csv",
  "text/plain",
]);

const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\:*?"<>|]/gu;
const MAX_NAME_LENGTH = 150;

export function safeFileName(name: string | null, fallback: string): string {
  const cleaned = (name ?? "")
    .replace(UNSAFE_NAME_CHARACTERS, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!cleaned) return fallback;
  return [...cleaned].slice(-MAX_NAME_LENGTH).join("");
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

export function downloadHeaders(
  name: string | null,
  mimeType: string,
  size: number | null,
  fallbackName: string,
): Headers {
  const fileName = safeFileName(name, fallbackName);
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replaceAll(";", "_");
  const type = mimeType.trim().toLowerCase();
  const headers = new Headers({
    "Content-Type": PASSIVE_TYPES.has(type) ? type : "application/octet-stream",
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(fileName)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "private, no-store",
  });
  if (size !== null) headers.set("Content-Length", String(size));
  return headers;
}
