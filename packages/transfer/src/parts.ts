// Shared with the browser, so nothing here may import server code.

// Decimal, because 10,000 parts of 10 MB is exactly the 100 GB limit. R2 needs
// every part but the last to be one size, so a part of any other size is refused.
export const PART_BYTES = 10_000_000;
export const MAX_PARTS = 10_000;
export const MAX_FILE_BYTES = PART_BYTES * MAX_PARTS;

export const partCountFor = (size: number) => Math.ceil(size / PART_BYTES);

export function expectedPartBytes(size: number, partNumber: number): number {
  return partNumber < partCountFor(size)
    ? PART_BYTES
    : size - PART_BYTES * (partCountFor(size) - 1);
}
