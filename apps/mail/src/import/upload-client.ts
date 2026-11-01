import type { ImportStatus } from "./uploads";
import {
  expectedPartBytes,
  type ImportJobView,
  type NewImportFile,
  PART_BYTES,
} from "./types";

const PARALLEL_PARTS = 3;
const PART_TRIES = 5;
const RETRY_DELAY_MS = 1000;
const FINGERPRINT_SAMPLE_BYTES = 1024 * 1024;

const CANNOT_REACH =
  "We couldn't reach CloudySuite. Check your connection and try again.";

// A refusal the server wrote for the person reading it, as opposed to a dropped
// connection. Trying the same request again would get the same answer.
export class ImportRefused extends Error {}

async function request<Value>(
  path: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<Value> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new Error(CANNOT_REACH);
  }
  if (response.ok) return (await response.json()) as Value;
  const body = (await response.json().catch(() => null)) as {
    message?: string;
  } | null;
  const message = body?.message ?? CANNOT_REACH;
  // A 5xx may pass, so only a 4xx is final.
  throw response.status < 500 ? new ImportRefused(message) : new Error(message);
}

const base = (mailboxId: string) => `/api/import/${mailboxId}`;

export const readStatus = (mailboxId: string) =>
  request<ImportStatus>(base(mailboxId), { method: "GET" });

export const startJob = (mailboxId: string, file: NewImportFile) =>
  request<ImportJobView>(`${base(mailboxId)}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(file),
  });

export const cancelJob = (mailboxId: string, jobId: string) =>
  request<ImportJobView>(`${base(mailboxId)}/jobs/${jobId}/cancel`, {
    method: "POST",
  });

// The name and size can match by chance, and hashing all of a large file would take
// minutes. The start and end of the file tell two exports apart in practice.
export async function fingerprintOf(file: File): Promise<string> {
  const sample = new Blob([
    file.slice(0, FINGERPRINT_SAMPLE_BYTES),
    file.slice(Math.max(0, file.size - FINGERPRINT_SAMPLE_BYTES)),
    String(file.size),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await sample.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type UploadProgress = { partsDone: number; partCount: number };

// Skips the parts the server already holds, which is the whole of resuming: this
// runs the same way for a new upload, a retry, and a return after a page reload.
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
  const present = new Set(job.uploadedParts);
  const missing: number[] = [];
  for (let part = 1; part <= job.partCount; part += 1) {
    if (!present.has(part)) missing.push(part);
  }
  let partsDone = present.size;
  onProgress({ partsDone, partCount: job.partCount });

  const sendPart = async (partNumber: number) => {
    const start = (partNumber - 1) * PART_BYTES;
    const body = file.slice(
      start,
      start + expectedPartBytes(job.size, partNumber),
    );
    for (let tries = 1; ; tries += 1) {
      try {
        await request(`${base(mailboxId)}/jobs/${job.id}/parts/${partNumber}`, {
          method: "PUT",
          body,
          signal,
        });
        return;
      } catch (error) {
        if (
          signal.aborted ||
          error instanceof ImportRefused ||
          tries === PART_TRIES
        ) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * 2 ** (tries - 1)),
        );
      }
    }
  };

  const worker = async () => {
    for (
      let partNumber = missing.shift();
      partNumber !== undefined;
      partNumber = missing.shift()
    ) {
      await sendPart(partNumber);
      partsDone += 1;
      onProgress({ partsDone, partCount: job.partCount });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_PARTS }, worker));

  return request<ImportJobView>(`${base(mailboxId)}/jobs/${job.id}/finish`, {
    method: "POST",
    signal,
  });
}
