import {
  fingerprintOf,
  type PartsProgress,
  sendParts,
  transferRequest,
} from "@cloudysuite/transfer";
import type { ImportStatus } from "./uploads";
import type { ImportJobView, NewImportFile } from "./types";

export { fingerprintOf };

const PART_TRIES = 5;

const base = (mailboxId: string) => `/api/import/${mailboxId}`;

export const readStatus = (mailboxId: string) =>
  transferRequest<ImportStatus>(base(mailboxId), { method: "GET" });

export const startJob = (mailboxId: string, file: NewImportFile) =>
  transferRequest<ImportJobView>(`${base(mailboxId)}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(file),
  });

export const cancelJob = (mailboxId: string, jobId: string) =>
  transferRequest<ImportJobView>(`${base(mailboxId)}/jobs/${jobId}/cancel`, {
    method: "POST",
  });

export type UploadProgress = PartsProgress;

export async function uploadFile({
  mailboxId,
  job,
  file,
  signal,
  onProgress,
}: {
  mailboxId: string;
  job: ImportJobView;
  file: File;
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
}): Promise<ImportJobView> {
  await sendParts({
    file,
    storedParts: job.uploadedParts,
    partPath: (partNumber) =>
      `${base(mailboxId)}/jobs/${job.id}/parts/${partNumber}`,
    maxTries: PART_TRIES,
    signal,
    onProgress,
  });
  return transferRequest<ImportJobView>(
    `${base(mailboxId)}/jobs/${job.id}/finish`,
    { method: "POST", signal },
  );
}
