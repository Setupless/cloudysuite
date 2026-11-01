// Shared with the browser, so nothing here may import server code. A GB here is 1000
// MB, as the amounts Storage shows are.
const BYTES_PER_GB = 1_000_000_000;
const MAX_LIMIT_GB = 1_000_000;

export const MAX_LIMIT_BYTES = MAX_LIMIT_GB * BYTES_PER_GB;

export const bytesToLimitText = (bytes: number | null): string =>
  bytes === null ? "" : String(bytes / BYTES_PER_GB);

export function parseLimitText(
  text: string,
): { ok: true; bytes: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  const bytes = /^\d+(\.\d+)?$/.test(trimmed)
    ? Math.round(Number(trimmed) * BYTES_PER_GB)
    : 0;
  return bytes >= 1 && bytes <= MAX_LIMIT_BYTES
    ? { ok: true, bytes }
    : {
        ok: false,
        message:
          "Enter an amount in GB, using only numbers, such as 100. It must be above 0 and no more than 1000000.",
      };
}
