import { downloadHeaders } from "@cloudysuite/transfer";
import type { DriveClient } from "./client";
import { canPreview, type ItemId } from "./types";

export const plainText = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

export const notFound = () =>
  plainText(404, "This file is no longer available.");

export async function downloadResponse(
  drive: DriveClient,
  itemId: ItemId,
): Promise<Response> {
  const download = await drive.download(itemId);
  const body = await download?.read();
  if (!download || !body) return notFound();
  return new Response(body, {
    headers: downloadHeaders(
      download.file.name,
      download.file.mimeType,
      download.file.size,
      "file",
    ),
  });
}

// The session cookie reaches this host, so an uploaded page that ran here would act as
// the person viewing it. This route serves only the four raster types, whatever else
// was claimed, and nosniff and the sandbox hold if the claim was a lie.
export async function previewResponse(
  drive: DriveClient,
  itemId: ItemId,
): Promise<Response> {
  const download = await drive.download(itemId);
  if (!download) return notFound();
  const { file } = download;
  if (!canPreview(file)) {
    return plainText(
      415,
      "This file can't be shown here. Download it to open it.",
    );
  }
  const body = await download.read();
  if (!body) return notFound();
  return new Response(body, {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.size),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "private, no-store",
    },
  });
}
