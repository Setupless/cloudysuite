import { expectedPartBytes, PART_BYTES, partCountFor } from "./parts";

const PARALLEL_PARTS = 3;
const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 30_000;
const FINGERPRINT_SAMPLE_BYTES = 1024 * 1024;

const CANNOT_REACH =
  "We couldn't reach CloudySuite. Check your connection and try again.";

// A refusal the server wrote for the person reading it, as opposed to a dropped
// connection. Trying the same request again would get the same answer.
export class UploadRefused extends Error {}

export async function transferRequest<Value>(
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
  throw response.status < 500 ? new UploadRefused(message) : new Error(message);
}

// The name and size can match by chance, and hashing all of a large file would take
// minutes. The start and end of the file tell two files apart in practice.
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

export const retryDelayMs = (tries: number) =>
  Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** (tries - 1));

export type PartsProgress = { partsDone: number; partCount: number };

// Skips the parts the server already holds, which is the whole of resuming: this
// runs the same way for a new upload, a retry, and a return after a page reload.
export async function sendParts({
  file,
  storedParts,
  partPath,
  maxTries,
  signal,
  onProgress,
  onRetrying,
}: {
  file: File;
  storedParts: readonly number[];
  partPath: (partNumber: number) => string;
  maxTries: number;
  signal: AbortSignal;
  onProgress: (progress: PartsProgress) => void;
  onRetrying?: () => void;
}): Promise<void> {
  const partCount = partCountFor(file.size);
  const present = new Set(storedParts);
  const missing: number[] = [];
  for (let part = 1; part <= partCount; part += 1) {
    if (!present.has(part)) missing.push(part);
  }
  let partsDone = present.size;
  onProgress({ partsDone, partCount });

  const sendPart = async (partNumber: number) => {
    const start = (partNumber - 1) * PART_BYTES;
    const body = file.slice(
      start,
      start + expectedPartBytes(file.size, partNumber),
    );
    for (let tries = 1; ; tries += 1) {
      try {
        await transferRequest(partPath(partNumber), {
          method: "PUT",
          body,
          signal,
        });
        return;
      } catch (error) {
        if (
          signal.aborted ||
          error instanceof UploadRefused ||
          tries === maxTries
        ) {
          throw error;
        }
        onRetrying?.();
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs(tries)),
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
      onProgress({ partsDone, partCount });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_PARTS }, worker));
}
