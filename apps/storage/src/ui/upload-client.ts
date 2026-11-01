import {
  fingerprintOf,
  PART_BYTES,
  retryDelayMs,
  sendParts,
  transferRequest,
  UploadRefused,
} from "@cloudysuite/transfer";
import type { FileItem, UploadView } from "../types";
import type { SendFile } from "./upload-queue";

// Keeps trying a dropped connection for as long as the tab is open. Only the server's
// own refusal or the person closing the upload ends it.
async function untilReached<Value>(
  run: () => Promise<Value>,
  signal: AbortSignal,
  onWaiting: () => void,
): Promise<Value> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await run();
    } catch (error) {
      if (signal.aborted || error instanceof UploadRefused) throw error;
      onWaiting();
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(tries)));
    }
  }
}

export const sendFile: SendFile = async ({
  driveId,
  folderId,
  file,
  signal,
  onSentBytes,
  onWaiting,
}) => {
  const base = `/api/drives/${driveId}/uploads`;
  const fingerprint = await fingerprintOf(file);
  const upload = await untilReached(
    () =>
      transferRequest<UploadView>(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentId: folderId,
          name: file.name,
          size: file.size,
          mimeType: file.type,
          fingerprint,
        }),
        signal,
      }),
    signal,
    onWaiting,
  );

  await sendParts({
    file,
    storedParts: upload.storedParts,
    partPath: (partNumber) => `${base}/${upload.id}/parts/${partNumber}`,
    maxTries: Number.POSITIVE_INFINITY,
    signal,
    onProgress: ({ partsDone, partCount }) =>
      onSentBytes(partsDone === partCount ? file.size : partsDone * PART_BYTES),
    onRetrying: onWaiting,
  });

  await untilReached(
    () =>
      transferRequest<FileItem>(`${base}/${upload.id}/complete`, {
        method: "POST",
        signal,
      }),
    signal,
    onWaiting,
  );
};
